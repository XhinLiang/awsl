import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

import { compileWorkflow } from "../../src/compat/compile.js";
import { AwslError } from "../../src/core/errors.js";
import { WorkerHost } from "../../src/worker/host.js";
import {
  MAX_IPC_PACKET_BYTES,
  isChildMessage,
  isPacketData,
  isParentMessage,
} from "../../src/worker/protocol.js";

function compiled(body: string) {
  return compileWorkflow(
    `export const meta={name:"worker",description:"worker test"};${body}`,
    "/tmp/worker.js",
  );
}

async function run(
  body: string,
  options: ConstructorParameters<typeof WorkerHost>[0] = {},
) {
  const host = new WorkerHost(options);
  try {
    return await host.run({ ...compiled(body), args: { value: 7 } });
  } finally {
    await host.close();
  }
}

function expectCode(error: unknown, code: string) {
  expect(error).toBeInstanceOf(AwslError);
  expect((error as AwslError).code).toBe(code);
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function expectFastWorkflowError(pending: Promise<unknown>) {
  const started = Date.now();
  const error = await pending.catch((reason: unknown) => reason);
  expectCode(error, "WORKFLOW_ERROR");
  expect(Date.now() - started).toBeLessThan(1_000);
}

const exitWorker = fileURLToPath(
  new URL("../fixtures/workflows/exit-worker.cjs", import.meta.url),
);
const heapWorker = fileURLToPath(
  new URL("../fixtures/workflows/heap-worker.cjs", import.meta.url),
);
const closeWorker = fileURLToPath(
  new URL("../fixtures/workflows/close-observable.cjs", import.meta.url),
);
const ignoreTermWorker = fileURLToPath(
  new URL("../fixtures/workflows/ignore-term.cjs", import.meta.url),
);
const callbackErrorWorker = fileURLToPath(
  new URL(
    "../fixtures/workflows/send-callback-error-worker.cjs",
    import.meta.url,
  ),
);
const backpressureWorker = fileURLToPath(
  new URL(
    "../fixtures/workflows/send-backpressure-worker.cjs",
    import.meta.url,
  ),
);

describe("VM worker", () => {
  test("accepts packet data only when its JSON UTF-8 wire payload fits", () => {
    const packet = (value: unknown) => ({ type: "result", value });
    const max = MAX_IPC_PACKET_BYTES;
    for (const value of [
      {},
      [],
      { empty: {} },
      { empty: [] },
      {
        '\u0000"\\\ud800\udc00\ud800': ['\u0000"\\\ud800\udc00\ud800'],
      },
      Array.from({ length: 4_000 }, () => []),
      Object.fromEntries(
        Array.from({ length: 4_000 }, (_, index) => [`key${index}`, {}]),
      ),
      { nested: [{ object: { empty: [] } }] },
    ]) {
      const candidate = packet(value);
      expect(isPacketData(candidate)).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(candidate), "utf8"),
      ).toBeLessThanOrEqual(max);
    }
    for (const value of [
      Array.from({ length: 99_997 }, (_, index) =>
        "x".repeat(index < 86 ? 82 : 81),
      ),
    ]) {
      const candidate = packet(value);
      expect(
        Buffer.byteLength(JSON.stringify(candidate), "utf8"),
      ).toBeGreaterThan(max);
      expect(isPacketData(candidate)).toBe(false);
    }

    const emptyKeyOverhead = Buffer.byteLength(
      JSON.stringify(packet({ "": false })),
      "utf8",
    );
    const exactKey = "x".repeat(max - emptyKeyOverhead);
    const exact = packet({ [exactKey]: false });
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(max);
    expect(isPacketData(exact)).toBe(true);

    const over = packet({ [`${exactKey}x`]: false });
    expect(Buffer.byteLength(JSON.stringify(over), "utf8")).toBe(max + 1);
    expect(isPacketData(over)).toBe(false);
  });

  test("enforces workflow reference and start timeout wire shapes", () => {
    for (const reference of [
      0,
      "",
      { scriptPath: "" },
      { scriptPath: "x", extra: true },
    ])
      expect(
        isChildMessage({
          type: "request",
          id: "1",
          method: "workflow",
          params: { reference },
        }),
      ).toBe(false);
    expect(
      isChildMessage({
        type: "request",
        id: "1",
        method: "workflow",
        params: { reference: { scriptPath: "x" } },
      }),
    ).toBe(true);
    for (const scriptTimeoutMs of [0, -1, 1.5, 2 ** 31])
      expect(
        isParentMessage({
          type: "start",
          runId: "r",
          code: "",
          filename: "x",
          budget: { total: null, spent: 0 },
          scriptTimeoutMs,
        }),
      ).toBe(false);
  });
  test("rejects invalid worker timing options before forking", () => {
    for (const value of ["1", 0, -1, 1.5, 2 ** 31])
      for (const key of [
        "scriptTimeoutMs",
        "watchdogMs",
        "abortGraceMs",
      ] as const)
        expect(() => new WorkerHost({ [key]: value } as never)).toThrow(
          /CONFIG_ERROR|must be/,
        );
  });
  test("runs top-level await and JSON-cloned args/result", async () => {
    await expect(
      run("await Promise.resolve(); return { value: args.value }"),
    ).resolves.toEqual({ value: 7 });
  });

  test("keeps omitted args undefined and timer handles opaque", async () => {
    const host = new WorkerHost();
    await expect(host.run({ ...compiled("return typeof args") })).resolves.toBe(
      "undefined",
    );
    await expect(
      run(
        "const h=setTimeout(()=>{}, 1); clearTimeout(h); return [typeof h, h.constructor.constructor('return process')()]",
      ),
    ).rejects.toThrow();
    await host.close();
  });

  test("proxies agent, phases, logs and every console level over IPC", async () => {
    const events: string[] = [];
    const result = await run(
      'phase("Plan"); log("one"); console.log("two", 2); console.info("three", 3); console.warn("four", 4); console.error("five", 5); console.debug("six", 6); return (await agent("hello", { model: "x" })).text',
      {
        agent: async (prompt, options) => ({
          value: { text: `${prompt}:${options.phase}` },
        }),
        onLog: (message, level) => events.push(`${level}:${message}`),
      },
    );
    expect(result).toBe("hello:Plan");
    expect(events).toEqual([
      "info:one",
      "log:two 2",
      "info:three 3",
      "warn:four 4",
      "error:five 5",
      "debug:six 6",
    ]);
  });

  test("parallel preserves order, turns local failures into null, and rejects invalid input", async () => {
    await expect(
      run(
        "return await parallel([async()=>3, async()=>{throw new Error('no')}, async()=>1])",
      ),
    ).resolves.toEqual([3, null, 1]);
    await expect(run("return await parallel([()=>1, 2])")).rejects.toThrow(
      /functions/,
    );
  });

  test("pipeline preserves item order, serial stages and null short circuit", async () => {
    const value = await run(
      "return await pipeline([1,2,3], async (prev, original, index) => index === 1 ? null : prev + original, (prev) => prev * 2)",
    );
    expect(value).toEqual([4, null, 12]);
  });

  test("pipeline has no cross-item stage barrier", async () => {
    const value = await run(`
      const order = []
      let releaseFirst
      const firstMayFinish = new Promise((resolve) => {
        releaseFirst = resolve
      })
      const result = await pipeline(
        [0, 1],
        async (previous, _original, index) => {
          order.push(\`stage-1-start:\${index}\`)
          if (index === 0) await firstMayFinish
          order.push(\`stage-1-end:\${index}\`)
          return previous
        },
        async (previous, _original, index) => {
          order.push(\`stage-2:\${index}\`)
          if (index === 1) releaseFirst()
          return previous
        },
      )
      return { order, result }
    `);

    expect(value).toEqual({
      order: [
        "stage-1-start:0",
        "stage-1-start:1",
        "stage-1-end:1",
        "stage-2:1",
        "stage-1-end:0",
        "stage-2:0",
      ],
      result: [0, 1],
    });
  });

  test("does not expose process or require", async () => {
    await expect(
      run("return [typeof process, typeof require]"),
    ).resolves.toEqual(["undefined", "undefined"]);
  });

  test.each([
    ["Date.now", "return Date.now()"],
    ["Date alias", "const D=Date; return D.now()"],
    ["bare Date", "return Date()"],
    ["zero Date", "return new Date()"],
    ["random alias", "const r=Math.random; return r()"],
    ["eval", "return eval('1')"],
    ["Function", "return Function('return 1')()"],
    [
      "wasm",
      "return new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))",
    ],
  ])("denies %s", async (_name, body) => {
    await expect(run(body)).rejects.toThrow();
  });

  test("allows Date construction with an explicit value", async () => {
    await expect(run("return new Date(0).getUTCFullYear()")).resolves.toBe(
      1970,
    );
  });

  test("keeps deterministic Math methods while denying random", async () => {
    await expect(run("return Math.floor(1.9)")).resolves.toBe(1);
  });

  test.each([
    ["Math method", "return Math.floor.constructor('return process')()"],
    ["agent", "return agent.constructor('return process')()"],
    ["workflow", "return workflow.constructor('return process')()"],
    ["timer", "return setTimeout.constructor('return process')()"],
    ["budget", "return budget.spent.constructor('return process')()"],
    ["args object", "return args.constructor.constructor('return process')()"],
    [
      "args array",
      "return args.items.constructor.constructor('return process')()",
    ],
  ])("does not escape through %s constructor chain", async (_name, body) => {
    const host = new WorkerHost();
    await expect(
      host.run({ ...compiled(body), args: { items: [1] } }),
    ).rejects.toThrow();
    await host.close();
  });

  test("keeps Date instance constructor inside the SafeDate guard", async () => {
    await expect(run("return new Date(0).constructor()")).rejects.toThrow(
      /Date/,
    );
  });

  test.each([
    ["Object.getPrototypeOf", "Object.getPrototypeOf(Date)"],
    ["Reflect.getPrototypeOf", "Reflect.getPrototypeOf(Date)"],
    ["Date.__proto__", "Date.__proto__"],
  ])("does not expose NativeDate through %s", async (_name, expression) => {
    await expect(
      run(
        `const Native=${expression}; let zeroArg=false; let now=false; try { new Native(); zeroArg=true } catch {} try { now=Native.now()>0 } catch {} return [zeroArg,now]`,
      ),
    ).resolves.toEqual([false, false]);
  });

  test("defines deterministic Date.parse and Date.UTC as own statics", async () => {
    await expect(
      run(
        "return [Object.hasOwn(Date,'parse'),Object.hasOwn(Date,'UTC'),Date.parse('1970-01-01T00:00:00.000Z'),Date.UTC(1970,0,1)]",
      ),
    ).resolves.toEqual([true, true, 0, 0]);
  });

  test("enforces sync and async watchdogs and aborts timer promptly", async () => {
    await expect(
      run("while(true) {}", { scriptTimeoutMs: 50 }),
    ).rejects.toThrow();
    await expect(
      run("await new Promise(() => {})", { watchdogMs: 50 }),
    ).rejects.toThrow();
    const host = new WorkerHost({ watchdogMs: 5000 });
    const pending = host.run({
      ...compiled(
        "await new Promise(resolve => setTimeout(resolve, 10000)); return 1",
      ),
      args: {},
    });
    setTimeout(() => host.abort(), 20);
    await expect(pending).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "CANCELLED");
      return true;
    });
    await host.close();
  });

  test("cancels a synchronous infinite worker after the abort grace period", async () => {
    const host = new WorkerHost({
      scriptTimeoutMs: 10_000,
      watchdogMs: 10_000,
      abortGraceMs: 25,
    });
    const pending = host.run({
      ...compiled("while (true) {}"),
      args: {},
    });
    setTimeout(() => host.abort(), 20);
    await expect(pending).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "CANCELLED");
      return true;
    });
    await host.close();
  });

  test("preserves a structured cancellation through cooperative and forced aborts", async () => {
    const cancellation = new AwslError("CANCELLED", "stop this exact run", {
      recoverable: true,
      runId: "run-cancel",
      callId: "call-cancel",
      phase: "plan",
      provider: "test-provider",
    });
    for (const body of [
      "await new Promise(resolve => setTimeout(resolve, 10000)); return 1",
      "while (true) {}",
    ]) {
      const host = new WorkerHost({
        scriptTimeoutMs: 10_000,
        watchdogMs: 10_000,
        abortGraceMs: 25,
      });
      const pending = host.run({ ...compiled(body), args: {} });
      setTimeout(() => host.abort(cancellation), 20);
      const error = await pending.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(AwslError);
      expect((error as AwslError).toJSON()).toEqual(cancellation.toJSON());
      await host.close();
    }
  });

  test("permanently poisons a host after cooperative cancellation", async () => {
    const host = new WorkerHost({ watchdogMs: 5_000, abortGraceMs: 25 });
    const first = host.run({
      ...compiled("await new Promise(resolve => setTimeout(resolve, 10000))"),
      args: {},
    });
    const cancellation = new AwslError("CANCELLED", "old cancellation", {
      recoverable: true,
      runId: "old-run",
    });
    setTimeout(() => host.abort(cancellation), 20);
    await expect(first).rejects.toMatchObject(cancellation.toJSON());
    await expect(
      host.run({ ...compiled("return 'reused'"), args: {} }),
    ).rejects.toThrow(/cannot be reused after abort/);
    await host.close();
  });

  test("rejects forged abort errors without affecting an active run", async () => {
    const host = new WorkerHost({ watchdogMs: 5_000 });
    const pending = host.run({
      ...compiled(
        "await new Promise(resolve => setTimeout(resolve, 35)); return 'ok'",
      ),
      args: {},
    });
    expect(() => host.abort({ code: "CANCELLED" } as never)).toThrow(AwslError);
    await expect(pending).resolves.toBe("ok");
    await host.close();
  });

  test("snapshots cancellation errors before the caller can mutate them", async () => {
    const host = new WorkerHost({ watchdogMs: 5_000, abortGraceMs: 20 });
    const pending = host.run({
      ...compiled("await new Promise(resolve => setTimeout(resolve, 10000))"),
      args: {},
    });
    const cancellation = new AwslError("CANCELLED", "original", {
      recoverable: true,
      runId: "before",
    });
    host.abort(cancellation);
    (cancellation as { message: string }).message = "mutated";
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: "original",
      runId: "before",
    });
    await host.close();
  });

  test("ignores a slow stale handler after abort and permanently poisons the host", async () => {
    let handlerCompleted = false;
    let markHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const host = new WorkerHost({
      watchdogMs: 5_000,
      abortGraceMs: 20,
      agent: async () => {
        markHandlerStarted();
        await delay(100);
        handlerCompleted = true;
        return { value: "late" };
      },
    });
    const first = host.run({
      ...compiled("return await agent('slow')"),
      args: {},
    });
    await handlerStarted;
    host.abort();
    await expect(first).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "CANCELLED");
      return true;
    });
    await expect(
      host.run({ ...compiled("return 'reused'"), args: {} }),
    ).rejects.toThrow(/cannot be reused after abort/);
    await delay(120);
    expect(handlerCompleted).toBe(true);
    await host.close();
  });

  test("updates budget from request responses and broadcasts", async () => {
    const snapshots: Array<{ total: number | null; spent: number }> = [];
    const value = await run(
      "const a=await agent('a'); const b=await agent('b'); return [budget.spent(), budget.remaining(), a.text+b.text]",
      {
        budget: { total: 10, spent: 0 },
        agent: async (prompt) => ({
          value: { text: prompt },
          budget: { total: 10, spent: prompt === "a" ? 1 : 2 },
        }),
        onBudget: (budget) => snapshots.push(budget),
      },
    );
    expect(value).toEqual([2, 8, "ab"]);
    expect(snapshots.at(-1)).toEqual({ total: 10, spent: 2 });
  });

  test("makes response budget visible before the agent promise resolves", async () => {
    await expect(
      run(
        "const value=await agent('a'); return [value, budget.spent(), budget.remaining()]",
        {
          budget: { total: 10, spent: 0 },
          agent: async () => ({
            value: "ok",
            budget: { total: 10, spent: 7 },
          }),
        },
      ),
    ).resolves.toEqual(["ok", 7, 3]);
  });

  test("makes an error response budget visible before catch resumes", async () => {
    const host = new WorkerHost({
      budget: { total: 10, spent: 0 },
      agent: async () => {
        host.updateBudget({ total: 10, spent: 6 });
        throw new AwslError("PROVIDER_ERROR", "failed", { recoverable: false });
      },
    });
    await expect(
      host.run({
        ...compiled(
          "try { await agent('x') } catch {} return [budget.spent(), budget.remaining()]",
        ),
        args: {},
      }),
    ).resolves.toEqual([6, 4]);
    await host.close();
  });

  test("makes external budget broadcasts visible during workflow execution", async () => {
    const host = new WorkerHost({ budget: { total: 10, spent: 0 } });
    const pending = host.run({
      ...compiled(
        "phase('wait'); await new Promise(resolve => setTimeout(resolve, 80)); return [budget.spent(), budget.remaining()]",
      ),
      args: {},
    });
    setTimeout(() => host.updateBudget({ total: 10, spent: 7 }), 20);
    await expect(pending).resolves.toEqual([7, 3]);
    await host.close();
  });

  test("never regresses spent from parallel stale responses or external updates", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const host = new WorkerHost({
      budget: { total: 10, spent: 0 },
      agent: async (prompt) => {
        if (prompt === "slow") await slow;
        return {
          value: prompt,
          budget: { total: 10, spent: prompt === "slow" ? 1 : 2 },
        };
      },
    });
    const pending = host.run({
      ...compiled(
        "return await parallel([()=>agent('slow'),()=>agent('fast')])",
      ),
      args: {},
    });
    await delay(15);
    host.updateBudget({ total: 10, spent: 7 });
    releaseSlow();
    await expect(pending).resolves.toEqual(["slow", "fast"]);
    await expect(
      host.run({ ...compiled("return budget.spent()"), args: {} }),
    ).resolves.toBe(7);
    await host.close();
  });

  test("rejects active budget total changes and external spent regressions but allows overshoot", async () => {
    const host = new WorkerHost({
      budget: { total: 2, spent: 1 },
      watchdogMs: 5_000,
    });
    const pending = host.run({
      ...compiled(
        "await new Promise(resolve => setTimeout(resolve, 35)); return budget.spent()",
      ),
      args: {},
    });
    expect(() => host.updateBudget({ total: 3, spent: 1 })).toThrow(/total/);
    expect(() => host.updateBudget({ total: 2, spent: 0 })).toThrow(/regress/);
    host.updateBudget({ total: 2, spent: 7 });
    await expect(pending).resolves.toBe(7);
    await host.close();
  });

  test("validates and clones workflow calls in the VM before IPC", async () => {
    let calls = 0;
    await expect(
      run("return await workflow('other', { x: args.value })", {
        workflow: async (reference, args) => {
          calls += 1;
          return { value: { reference, args } };
        },
      }),
    ).resolves.toEqual({ reference: "other", args: { x: 7 } });
    expect(calls).toBe(1);
    await expect(
      run(
        "return await workflow({ scriptPath: 'child.js' }, [1, { x: true }])",
        {
          workflow: async (reference, args) => ({
            value: { reference, args },
          }),
        },
      ),
    ).resolves.toEqual({
      reference: { scriptPath: "child.js" },
      args: [1, { x: true }],
    });

    let invalidCalls = 0;
    const invalidOptions = {
      workflow: async () => {
        invalidCalls += 1;
        return { value: "unexpected" };
      },
    };
    for (const body of [
      "return await workflow('', {})",
      "return await workflow({ scriptPath: '' }, {})",
      "return await workflow({ scriptPath: 'a', extra: true }, {})",
      "return await workflow({ wrong: 'a' }, {})",
      "return await workflow('a', undefined)",
      "return await workflow('a', { value: undefined })",
      "return await workflow('a', [1,,2])",
      "return await workflow('a', { value: Infinity })",
      "return await workflow('a', BigInt(1))",
      "return await workflow('a', () => {})",
      "return await workflow('a', Symbol('x'))",
      "const circular={}; circular.self=circular; return await workflow('a', circular)",
      "return await workflow('a', new Date(0))",
    ])
      await expect(run(body, invalidOptions)).rejects.toThrow();
    expect(invalidCalls).toBe(0);

    let omitted: unknown = null;
    await expect(
      run("return await workflow('no-args')", {
        workflow: async (reference, args) => {
          omitted = args;
          return { value: reference };
        },
      }),
    ).resolves.toBe("no-args");
    expect(omitted).toBeUndefined();
  });

  test("validates agent inputs", async () => {
    await expect(run("return await agent(1)")).rejects.toThrow(/prompt/);
    await expect(run("return await agent('x', [])")).rejects.toThrow(/options/);
  });

  test("strictly clones agent options before IPC and preserves an own __proto__ key", async () => {
    let calls = 0;
    const agent = async (_prompt: string, options: Record<string, unknown>) => {
      calls += 1;
      return { value: options };
    };
    for (const body of [
      "return await agent('x', { value: undefined })",
      "return await agent('x', { value: () => {} })",
      "return await agent('x', { value: Symbol('x') })",
      "return await agent('x', { value: BigInt(1) })",
      "return await agent('x', [1,,2])",
      "const x={}; x.self=x; return await agent('x', x)",
      "return await agent('x', new Date(0))",
    ]) {
      const outcome = await run(body, { agent }).then(
        () => "resolved",
        () => "rejected",
      );
      expect(outcome, body).toBe("rejected");
    }
    expect(calls).toBe(0);
    const preserved = await run(
      "const o=JSON.parse('{\\\"__proto__\\\":\\\"safe\\\"}'); return await agent('x', o)",
      { agent },
    );
    expect(Object.hasOwn(preserved as object, "__proto__")).toBe(true);
    expect((preserved as Record<string, unknown>).__proto__).toBe("safe");
  });

  test("requires an explicit WorkerHandlerResult without unwrapping domain values", async () => {
    await expect(
      run("return await agent('domain')", {
        agent: async () => ({
          value: { value: "domain", budget: { domain: true } },
        }),
      }),
    ).resolves.toEqual({ value: "domain", budget: { domain: true } });
    await expect(
      run("return await agent('missing')", {
        agent: async () => undefined as never,
      }),
    ).rejects.toThrow(/WorkerHandlerResult/);
  });

  test("round-trips every structured AwslError field", async () => {
    const failure = new AwslError("PROVIDER_ERROR", "provider failed", {
      recoverable: true,
      runId: "run-7",
      callId: "call-8",
      phase: "summarize",
      provider: "codex",
    });
    const caught = await run(
      "try { await agent('caught') } catch (error) { let escaped=false; try { error.constructor.constructor('return process')() } catch {} return [error.name,error.code,error.message,error.recoverable,error.runId,error.callId,error.phase,error.provider,escaped] }",
      { agent: async () => Promise.reject(failure) },
    );
    expect(caught).toEqual([
      "AwslError",
      "PROVIDER_ERROR",
      "provider failed",
      true,
      "run-7",
      "call-8",
      "summarize",
      "codex",
      false,
    ]);

    const host = new WorkerHost({
      agent: async () => Promise.reject(failure),
    });
    const rejection = await host
      .run({
        ...compiled("return await agent('uncaught')"),
        args: {},
      })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AwslError);
    expect((rejection as AwslError).toJSON()).toEqual(failure.toJSON());
    await host.close();
  });

  test("only trusted cancellation bypasses parallel and pipeline recovery", async () => {
    const fake =
      "Object.assign(new Error('fake'),{code:'CANCELLED',recoverable:false,runId:'forged'})";
    await expect(
      run(`return await parallel([async()=>{throw ${fake}},async()=>2])`),
    ).resolves.toEqual([null, 2]);
    await expect(
      run(`return await pipeline([1],async()=>{throw ${fake}})`),
    ).resolves.toEqual([null]);

    for (const body of [
      "return await parallel([async()=>await agent('cancel')])",
      "return await pipeline([1],async()=>await agent('cancel'))",
    ]) {
      const host = new WorkerHost({
        agent: async () =>
          Promise.reject(
            new AwslError("CANCELLED", "trusted cancellation", {
              recoverable: false,
              runId: "trusted",
            }),
          ),
      });
      const error = await host
        .run({ ...compiled(body), args: {} })
        .catch((reason: unknown) => reason);
      expectCode(error, "CANCELLED");
      expect((error as AwslError).runId).toBe("trusted");
      await host.close();
    }
  });

  test("rethrows global cancellation from parallel and pipeline", async () => {
    for (const body of [
      "return await parallel([()=>new Promise(r=>setTimeout(r,10000))])",
      "return await pipeline([1], ()=>new Promise(r=>setTimeout(r,10000)))",
    ]) {
      const host = new WorkerHost({ watchdogMs: 5000 });
      const pending = host.run({ ...compiled(body), args: {} });
      setTimeout(() => host.abort(), 20);
      await expect(pending).rejects.toSatisfy((error: unknown) => {
        expectCode(error, "CANCELLED");
        return true;
      });
      await host.close();
    }
  });

  test("rejects unserializable values and maps unexpected worker exits", async () => {
    await expect(run("return { bad: BigInt(1) }")).rejects.toThrow(/JSON/);
    const exiting = new WorkerHost({ workerPath: exitWorker });
    await expect(
      exiting.run({ ...compiled("return 1"), args: {} }),
    ).rejects.toThrow(/exited unexpectedly/);
    await exiting.close();
  });

  test("fails closed quickly when the real worker send callback reports an error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awsl-callback-error-"));
    const pidFile = join(directory, "pid");
    const prior = process.env.AWSL_CALLBACK_PID_FILE;
    process.env.AWSL_CALLBACK_PID_FILE = pidFile;
    try {
      const host = new WorkerHost({
        workerPath: callbackErrorWorker,
        watchdogMs: 5_000,
        agent: async () => ({ value: "unexpected" }),
      });
      const pending = host.run({
        ...compiled("return await agent('request')"),
        args: {},
      });
      for (let tries = 0; !existsSync(pidFile) && tries < 50; tries += 1)
        await delay(5);
      const pid = Number(readFileSync(pidFile, "utf8"));
      await expectFastWorkflowError(pending);
      expect(() => process.kill(pid, 0)).toThrow();
      await host.close();
    } finally {
      if (prior === undefined)
        Reflect.deleteProperty(process.env, "AWSL_CALLBACK_PID_FILE");
      else process.env.AWSL_CALLBACK_PID_FILE = prior;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed quickly when the real worker send reports backpressure", async () => {
    const host = new WorkerHost({
      workerPath: backpressureWorker,
      watchdogMs: 5_000,
      agent: async () => ({ value: "unexpected" }),
    });
    await expectFastWorkflowError(
      host.run({ ...compiled("return await agent('request')"), args: {} }),
    );
    await host.close();
  });

  test("fails closed when host to worker send reports backpressure", async () => {
    let restoreSend: (() => void) | undefined;
    const host = new WorkerHost({
      watchdogMs: 5_000,
      agent: async () => ({ value: "unexpected" }),
      forkWorker: (modulePath, args, options) => {
        const child = fork(modulePath, args, options);
        const send = vi
          .spyOn(child, "send")
          .mockImplementation(() => false as never);
        restoreSend = () => send.mockRestore();
        return child;
      },
    });
    try {
      await expectFastWorkflowError(
        host.run({ ...compiled("return await agent('request')"), args: {} }),
      );
    } finally {
      restoreSend?.();
      await host.close();
    }
  });

  test("rejects invalid args as WORKFLOW_ERROR before a reusable run", async () => {
    const host = new WorkerHost();
    for (const args of [
      { value: BigInt(1) },
      (() => {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        return circular;
      })(),
      { value: undefined },
    ]) {
      const error = await host
        .run({ ...compiled("return 1"), args })
        .catch((reason: unknown) => reason);
      expectCode(error, "WORKFLOW_ERROR");
    }
    await expect(
      host.run({ ...compiled("return args.ok"), args: { ok: true } }),
    ).resolves.toBe(true);
    await host.close();
  });

  test("strictly rejects getters, proxies, hidden fields, and array properties without reading getters", async () => {
    let reads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    const hidden = { value: 1 };
    Object.defineProperty(hidden, "hidden", { value: 2, enumerable: false });
    const array = [1];
    (array as unknown as Record<string, unknown>).extra = 2;
    for (const args of [accessor, new Proxy({ value: 1 }, {}), hidden, array]) {
      await expect(
        new WorkerHost().run({ ...compiled("return 1"), args }),
      ).rejects.toThrow(/strict JSON/);
    }
    expect(reads).toBe(0);
  });

  test("strictly rejects handler and VM result values rather than stringify coercing them", async () => {
    const host = new WorkerHost({
      agent: async () => ({ value: { bad: undefined } }),
    });
    await expect(
      host.run({ ...compiled("return await agent('x')"), args: {} }),
    ).rejects.toThrow(/non-JSON/);
    await host.close();
    await expect(run("return { bad: undefined }")).rejects.toThrow(
      /strict JSON/,
    );
  });

  test("rejects handler-result accessors without invoking them", async () => {
    let reads = 0;
    const host = new WorkerHost({
      agent: async () => {
        const result = {} as Record<string, unknown>;
        Object.defineProperty(result, "value", {
          enumerable: true,
          get: () => {
            reads += 1;
            return "unexpected";
          },
        });
        return result as never;
      },
    });
    await expect(
      host.run({ ...compiled("return await agent('x')"), args: {} }),
    ).rejects.toThrow(/enumerable data property/);
    expect(reads).toBe(0);
    await host.close();
  });

  test("closes only after the active run settles and permanently closes the host", async () => {
    const host = new WorkerHost({ watchdogMs: 5_000, abortGraceMs: 20 });
    const pending = host.run({
      ...compiled("await new Promise(resolve => setTimeout(resolve, 10000))"),
      args: {},
    });
    await host.close();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      host.run({ ...compiled("return 'next'"), args: {} }),
    ).rejects.toThrow(/worker host is closed/);
    await host.close();
  });

  test("close waits for the child close before resolving", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awsl-close-"));
    const pidFile = join(directory, "pid");
    const prior = process.env.AWSL_CLOSE_PID_FILE;
    process.env.AWSL_CLOSE_PID_FILE = pidFile;
    try {
      const host = new WorkerHost({
        workerPath: closeWorker,
        abortGraceMs: 10,
      });
      const pending = host.run({ ...compiled("return 1"), args: {} });
      for (let tries = 0; !existsSync(pidFile) && tries < 50; tries += 1)
        await delay(5);
      const pid = Number(readFileSync(pidFile, "utf8"));
      await host.close();
      await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (prior === undefined)
        Reflect.deleteProperty(process.env, "AWSL_CLOSE_PID_FILE");
      else process.env.AWSL_CLOSE_PID_FILE = prior;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("close escalates an ignored SIGTERM and waits for pid death", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awsl-kill-"));
    const pidFile = join(directory, "pid");
    const prior = process.env.AWSL_CLOSE_PID_FILE;
    process.env.AWSL_CLOSE_PID_FILE = pidFile;
    try {
      const host = new WorkerHost({
        workerPath: ignoreTermWorker,
        abortGraceMs: 20,
      });
      const pending = host.run({ ...compiled("return 1"), args: {} });
      for (let tries = 0; !existsSync(pidFile) && tries < 50; tries += 1)
        await delay(5);
      const pid = Number(readFileSync(pidFile, "utf8"));
      const started = Date.now();
      await host.close();
      expect(Date.now() - started).toBeLessThan(500);
      await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (prior === undefined)
        Reflect.deleteProperty(process.env, "AWSL_CLOSE_PID_FILE");
      else process.env.AWSL_CLOSE_PID_FILE = prior;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "sync",
      "setTimeout(()=>{throw new Error('timer sync')},0); await new Promise(resolve=>setTimeout(resolve,20)); return 1",
    ],
    [
      "async",
      "setTimeout(async()=>{throw new Error('timer async')},0); await new Promise(resolve=>setTimeout(resolve,20)); return 1",
    ],
  ])("routes %s timer callback failures into the run", async (_kind, body) => {
    await expect(run(body)).rejects.toThrow(/timer (sync|async)/);
  });

  test("rejects workflow accessor and proxy packets before parent IPC", async () => {
    let calls = 0;
    const workflow = async () => {
      calls += 1;
      return { value: 1 };
    };
    await expect(
      run(
        "const ref={}; Object.defineProperty(ref,'scriptPath',{enumerable:true,get(){ throw new Error('getter read') }}); return workflow(ref, {})",
        { workflow },
      ),
    ).rejects.toThrow(/enumerable data property/);
    await expect(
      run("return workflow(new Proxy({scriptPath:'child'}, {}), {})", {
        workflow,
      }),
    ).rejects.toThrow(/proxy/);
    expect(calls).toBe(0);
  });

  test("bounds flooded diagnostics while preserving phase-before-agent order", async () => {
    const events: string[] = [];
    await expect(
      run(
        "phase('p'); for(let i=0;i<10000;i++) log('x'+i); return (await agent('a')).value",
        {
          agent: async () => {
            events.push("agent");
            return { value: { value: 1 } };
          },
          onPhase: (title) => events.push(`phase:${title}`),
          onLog: () => events.push("log"),
          watchdogMs: 5_000,
        },
      ),
    ).resolves.toBe(1);
    expect(events[0]).toBe("phase:p");
    expect(events.indexOf("agent")).toBeGreaterThan(0);
    expect(
      events.filter((event) => event === "log").length,
    ).toBeLessThanOrEqual(255);
  });

  test("bounds worker IPC agent floods and fails closed without reusing the host", async () => {
    const host = new WorkerHost({
      agent: async () => ({ value: null }),
      watchdogMs: 10_000,
    });
    await expect(
      host.run({
        ...compiled(
          "return await parallel(Array.from({length:1001},()=>()=>agent('x')))",
        ),
        args: {},
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_ERROR" });
    await host.close();
  }, 20_000);

  test("uses an immutable validated heap bound for every worker", async () => {
    const defaultHost = new WorkerHost({ workerPath: heapWorker });
    await expect(
      defaultHost.run({ ...compiled("return 1"), args: {} }),
    ).resolves.toEqual(["--max-old-space-size=128"]);
    await defaultHost.close();

    const host = new WorkerHost({
      workerPath: heapWorker,
      maxOldSpaceMb: 16,
    });
    await expect(
      host.run({ ...compiled("return 1"), args: {} }),
    ).resolves.toEqual(["--max-old-space-size=16"]);
    await host.close();

    for (const maxOldSpaceMb of [15, 4097, 16.5, Number.NaN]) {
      expect(() => new WorkerHost({ maxOldSpaceMb })).toThrow(/maxOldSpaceMb/);
    }
  });

  test("captures the validated heap bound before caller option mutation", async () => {
    const mutableOptions = {
      workerPath: heapWorker,
      maxOldSpaceMb: 16,
    };
    const host = new WorkerHost(mutableOptions);
    mutableOptions.maxOldSpaceMb = 8_192;
    try {
      (host.options as { maxOldSpaceMb?: number }).maxOldSpaceMb = 4_096;
    } catch {}
    await expect(
      host.run({ ...compiled("return 1"), args: {} }),
    ).resolves.toEqual(["--max-old-space-size=16"]);
    await host.close();
  });

  test("clearTimeout prevents callbacks and invalid callbacks fail synchronously", async () => {
    await expect(
      run(
        "let called=false; const handle=setTimeout(()=>{called=true},10); clearTimeout(handle); await new Promise(resolve=>setTimeout(resolve,30)); return [called,typeof handle]",
      ),
    ).resolves.toEqual([false, "number"]);
    await expect(run("setTimeout('nope', 1); return 1")).rejects.toThrow(
      /callback/,
    );
  });
});
