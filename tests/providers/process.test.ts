import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { COMPATIBILITY_PROFILE } from "../../src/compat/profile.js";
import { AwslError } from "../../src/core/errors.js";
import { runProviderProcess } from "../../src/providers/process.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/bin/fake-transport.mjs", import.meta.url),
);
const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "awsl-transport-test-"));
  temporaryPaths.push(directory);
  return directory;
}

function fixtureEnvironment(
  scenario: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    AWSL_TRANSPORT_SCENARIO: scenario,
    ...overrides,
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("runProviderProcess", () => {
  test("uses the exact compatibility-profile transport defaults", () => {
    expect(COMPATIBILITY_PROFILE.providerProcess).toEqual({
      maxNdjsonLineBytes: 8 * 1024 * 1024,
      stderrTailBytes: 64 * 1024,
      killGraceMs: 1_000,
    });
  });

  test("uses exact argv and cwd, inherits env, and keeps hostile text off a shell", async () => {
    const cwd = await temporaryDirectory();
    const marker = path.join(cwd, "shell-injection-marker");
    const hostileArgument = `$(touch ${marker})`;
    const hostilePrompt = `prompt with \`touch ${marker}\` and $()`;
    const canonicalCwd = await realpath(cwd);
    const events: unknown[] = [];

    await runProviderProcess({
      executable: fixturePath,
      argv: ["literal argument", hostileArgument, ";", "&&"],
      cwd,
      prompt: hostilePrompt,
      signal: new AbortController().signal,
      env: fixtureEnvironment("capture", {
        AWSL_TRANSPORT_OVERRIDE: "present",
      }),
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toEqual([
      {
        type: "capture",
        argv: ["literal argument", hostileArgument, ";", "&&"],
        cwd: canonicalCwd,
        prompt: hostilePrompt,
        inheritedPath: true,
        override: "present",
      },
    ]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves a legitimate own __proto__ environment override", async () => {
    const events: unknown[] = [];
    const env = JSON.parse(
      '{"AWSL_TRANSPORT_SCENARIO":"capture-proto","__proto__":"provider-context"}',
    ) as NodeJS.ProcessEnv;

    await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: new AbortController().signal,
      env,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toEqual([
      {
        type: "proto",
        own: true,
        value: "provider-context",
      },
    ]);
  });

  test("decodes UTF-8 split across stdout chunks", async () => {
    const events: unknown[] = [];

    await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("utf8-split"),
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toEqual([{ type: "unicode", value: "雪🙂" }]);
  });

  test("accepts CRLF and a final line without LF while ignoring blank lines", async () => {
    const events: unknown[] = [];

    await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("line-endings"),
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toEqual([
      { type: "first", value: 1 },
      { type: "second", value: 2 },
    ]);
  });

  test("accepts an exact byte-limit line and rejects one byte more", async () => {
    const cwd = await temporaryDirectory();
    const limit = 32;
    const accepted: unknown[] = [];

    await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd,
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("line-bytes", {
        AWSL_TRANSPORT_LINE_BYTES: String(limit),
      }),
      maxLineBytes: limit,
      onEvent: (event) => {
        accepted.push(event);
      },
    });
    expect(accepted).toEqual([{ value: "a".repeat(20) }]);

    await expect(
      runProviderProcess({
        executable: fixturePath,
        argv: [],
        cwd,
        prompt: "",
        signal: new AbortController().signal,
        env: fixtureEnvironment("line-bytes", {
          AWSL_TRANSPORT_LINE_BYTES: String(limit + 1),
        }),
        maxLineBytes: limit,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      recoverable: false,
    });
  });

  test("retains only the configured stderr byte tail without exposing it in errors", async () => {
    const cwd = await temporaryDirectory();
    const result = await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd,
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("stderr-success"),
      stderrLimitBytes: 10,
    });

    expect(result.stderrTail).toEqual(Buffer.from("QRSTUVWXYZ"));

    const failure = await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd,
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("nonzero"),
      stderrLimitBytes: 10,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "PROVIDER_ERROR",
      recoverable: false,
    });
    expect(String(failure)).not.toContain("RAW_STDERR_SUPER_SECRET");
    expect(JSON.stringify(failure)).not.toContain("RAW_STDERR_SUPER_SECRET");
  });

  test("awaits event callbacks sequentially and preserves order", async () => {
    const seen: number[] = [];
    let activeCallbacks = 0;
    let peakCallbacks = 0;

    await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("ordered-events"),
      onEvent: async (event) => {
        activeCallbacks += 1;
        peakCallbacks = Math.max(peakCallbacks, activeCallbacks);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push((event as { index: number }).index);
        activeCallbacks -= 1;
      },
    });

    expect(seen).toEqual([1, 2, 3]);
    expect(peakCallbacks).toBe(1);
  });

  test("terminates and rejects generically when an event callback throws", async () => {
    const failure = await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("ordered-events"),
      onEvent: () => {
        throw new Error("CALLBACK_PRIVATE_DETAIL");
      },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(String(failure)).not.toContain("CALLBACK_PRIVATE_DETAIL");
  });

  test("preserves the exact persistence callback error", async () => {
    const persistence = new AwslError("PERSISTENCE_ERROR", "disk sync failed", {
      recoverable: false,
    });
    const failure = await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("ordered-events"),
      onEvent: () => {
        throw persistence;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBe(persistence);
    expect(failure).toMatchObject({ code: "PERSISTENCE_ERROR" });
  });

  test("rejects malformed NDJSON without echoing the raw line", async () => {
    const failure = await runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: new AbortController().signal,
      env: fixtureEnvironment("malformed"),
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(String(failure)).not.toContain("RAW_MALFORMED");
  });

  test("rejects a nonzero exit even when stderr is present", async () => {
    await expect(
      runProviderProcess({
        executable: fixturePath,
        argv: [],
        cwd: await temporaryDirectory(),
        prompt: "",
        signal: new AbortController().signal,
        env: fixtureEnvironment("nonzero"),
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      recoverable: false,
    });
  });

  test("handles spawn errors once without leaking the executable details", async () => {
    const missing = path.join(
      await temporaryDirectory(),
      "missing-provider-PRIVATE",
    );
    const failure = await runProviderProcess({
      executable: missing,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(String(failure)).not.toContain("PRIVATE");
  });

  test("rejects when the provider closes stdin before a large prompt is written", async () => {
    await expect(
      runProviderProcess({
        executable: fixturePath,
        argv: [],
        cwd: await temporaryDirectory(),
        prompt: "x".repeat(32 * 1024 * 1024),
        signal: new AbortController().signal,
        env: fixtureEnvironment("stdin-close"),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  test("does not spawn when already aborted", async () => {
    const cwd = await temporaryDirectory();
    const marker = path.join(cwd, "spawn-marker");
    const controller = new AbortController();
    controller.abort();

    await expect(
      runProviderProcess({
        executable: fixturePath,
        argv: [],
        cwd,
        prompt: "",
        signal: controller.signal,
        env: fixtureEnvironment("capture", {
          AWSL_TRANSPORT_MARKER: marker,
        }),
      }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
      recoverable: false,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cancellation dominates after output but before process close", async () => {
    const controller = new AbortController();

    const running = runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: controller.signal,
      env: fixtureEnvironment("terminal-then-hang"),
      killGraceMs: 10,
      onEvent: () => {
        controller.abort();
      },
    });

    await expect(running).rejects.toMatchObject({
      code: "CANCELLED",
      recoverable: false,
    });
  });

  test("cancellation wins over a callback failure triggered by the same event", async () => {
    const controller = new AbortController();

    const running = runProviderProcess({
      executable: fixturePath,
      argv: [],
      cwd: await temporaryDirectory(),
      prompt: "",
      signal: controller.signal,
      env: fixtureEnvironment("terminal-then-hang"),
      killGraceMs: 10,
      onEvent: () => {
        controller.abort();
        throw new Error("late callback failure");
      },
    });

    await expect(running).rejects.toMatchObject({
      code: "CANCELLED",
      recoverable: false,
    });
  });

  test.runIf(process.platform !== "win32")(
    "kills the whole process group, including a SIGTERM-ignoring grandchild, before rejecting",
    async () => {
      const controller = new AbortController();
      let parentPid: number | undefined;
      let grandchildPid: number | undefined;
      let markReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });

      const running = runProviderProcess({
        executable: fixturePath,
        argv: [],
        cwd: await temporaryDirectory(),
        prompt: "",
        signal: controller.signal,
        env: fixtureEnvironment("hang-with-grandchild"),
        killGraceMs: 20,
        onEvent: (event) => {
          const value = event as {
            parentPid: number;
            grandchildPid: number;
          };
          parentPid = value.parentPid;
          grandchildPid = value.grandchildPid;
          markReady?.();
        },
      });

      await ready;
      controller.abort();
      await expect(running).rejects.toMatchObject({
        code: "CANCELLED",
        recoverable: false,
      });

      expect(parentPid).toEqual(expect.any(Number));
      expect(grandchildPid).toEqual(expect.any(Number));
      expect(processExists(parentPid as number)).toBe(false);
      expect(processExists(grandchildPid as number)).toBe(false);
    },
  );

  test.runIf(process.platform !== "win32")(
    "does not return success while a provider descendant is still alive",
    async () => {
      let parentPid: number | undefined;
      let grandchildPid: number | undefined;

      const result = await runProviderProcess({
        executable: fixturePath,
        argv: [],
        cwd: await temporaryDirectory(),
        prompt: "",
        signal: new AbortController().signal,
        env: fixtureEnvironment("success-with-grandchild"),
        killGraceMs: 20,
        onEvent: (event) => {
          const value = event as {
            parentPid: number;
            grandchildPid: number;
          };
          parentPid = value.parentPid;
          grandchildPid = value.grandchildPid;
        },
      });

      expect(result).toMatchObject({ exitCode: 0, eventCount: 1 });
      expect(parentPid).toEqual(expect.any(Number));
      expect(grandchildPid).toEqual(expect.any(Number));
      expect(processExists(parentPid as number)).toBe(false);
      expect(processExists(grandchildPid as number)).toBe(false);
    },
  );

  test.runIf(process.platform !== "win32")(
    "cleans an inherited-stdio descendant as soon as the successful provider exits",
    async () => {
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), 1_000);
      let grandchildPid: number | undefined;
      try {
        const result = await runProviderProcess({
          executable: fixturePath,
          argv: [],
          cwd: await temporaryDirectory(),
          prompt: "",
          signal: controller.signal,
          env: fixtureEnvironment("success-with-inherited-stdio-grandchild"),
          killGraceMs: 20,
          onEvent: (event) => {
            grandchildPid = (event as { grandchildPid: number }).grandchildPid;
          },
        });

        expect(result).toMatchObject({ exitCode: 0, eventCount: 1 });
        expect(grandchildPid).toEqual(expect.any(Number));
        expect(processExists(grandchildPid as number)).toBe(false);
      } finally {
        clearTimeout(watchdog);
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "cleans an inherited-stdio descendant before reporting a nonzero exit",
    async () => {
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), 1_000);
      let grandchildPid: number | undefined;
      try {
        await expect(
          runProviderProcess({
            executable: fixturePath,
            argv: [],
            cwd: await temporaryDirectory(),
            prompt: "",
            signal: controller.signal,
            env: fixtureEnvironment("failure-with-inherited-stdio-grandchild"),
            killGraceMs: 20,
            onEvent: (event) => {
              grandchildPid = (event as { grandchildPid: number })
                .grandchildPid;
            },
          }),
        ).rejects.toMatchObject({
          code: "PROVIDER_ERROR",
          recoverable: false,
        });
        expect(grandchildPid).toEqual(expect.any(Number));
        expect(processExists(grandchildPid as number)).toBe(false);
      } finally {
        clearTimeout(watchdog);
      }
    },
  );
});
