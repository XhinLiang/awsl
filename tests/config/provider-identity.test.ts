import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  type ProviderVersionProbe,
  resolveProviderIdentity,
  validateNormalizedProviderVersion,
} from "../../src/config/provider-identity.js";
import { AwslError } from "../../src/core/errors.js";

const paths: string[] = [];

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "awsl-provider-identity-"));
  paths.push(result);
  return result;
}

async function executable(
  directoryPath: string,
  name = "tool",
): Promise<string> {
  const result = join(directoryPath, name);
  await writeFile(result, "#!/bin/sh\nexit 0\n");
  await chmod(result, 0o755);
  return result;
}

function probe(
  stdout: Uint8Array | string,
  stderr: Uint8Array | string = "",
  exitCode = 0,
): ProviderVersionProbe {
  return async () => ({
    stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
    stderr: typeof stderr === "string" ? Buffer.from(stderr) : stderr,
    exitCode,
  });
}

function configError(error: unknown): boolean {
  expect(error).toMatchObject({
    code: "CONFIG_ERROR",
    recoverable: false,
  });
  expect((error as Error).cause).toBeUndefined();
  return true;
}

afterEach(async () => {
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("provider identity resolution", () => {
  test("passes the canonical explicit executable and cwd to an own-data injected probe", async () => {
    const cwd = await directory();
    const target = await realpath(await executable(cwd, "codex"));
    const calls: unknown[] = [];
    const injected: ProviderVersionProbe = async (options) => {
      calls.push(options);
      return {
        stdout: Buffer.from("codex-cli 0.145.0\n"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    };

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: "./codex",
        cwd,
        env: {},
        probe: injected,
      }),
    ).resolves.toEqual({
      id: "codex",
      executableRealpath: target,
      version: "0.145.0",
    });
    expect(calls).toEqual([
      {
        executableRealpath: target,
        cwd: await realpath(cwd),
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      },
    ]);
  });

  test("does not inspect PATH for an explicit lexical path", async () => {
    const cwd = await directory();
    await executable(cwd, "claude");
    let pathReads = 0;
    const environment = {};
    Object.defineProperty(environment, "PATH", {
      enumerable: true,
      get() {
        pathReads += 1;
        throw new Error("PATH must not be read");
      },
    });

    await expect(
      resolveProviderIdentity({
        provider: "claude",
        executable: "./claude",
        cwd,
        env: environment,
        probe: probe("2.1.218 (Claude Code)\n"),
      }),
    ).resolves.toMatchObject({ id: "claude", version: "2.1.218" });
    expect(pathReads).toBe(0);
  });

  test("validates every PATH segment before selecting a candidate", async () => {
    const cwd = await directory();
    const bin = await directory();
    await executable(bin, "codex");

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: "codex",
        cwd,
        env: { PATH: `${bin}${delimiter}relative` },
        probe: probe("codex-cli 0.145.0"),
      }),
    ).rejects.toSatisfy(configError);
  });

  test("skips missing and regular-file PATH entries before using a valid directory", async () => {
    const cwd = await directory();
    const missing = join(await directory(), "missing");
    const regularFile = join(await directory(), "not-a-directory");
    await writeFile(regularFile, "not a directory");
    const bin = await directory();
    const target = await realpath(await executable(bin, "codex"));
    let calls = 0;

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: "codex",
        cwd,
        env: {
          PATH: [missing, regularFile, bin].join(delimiter),
        },
        probe: async () => {
          calls += 1;
          return {
            stdout: Buffer.from("codex-cli 0.145.0"),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          };
        },
      }),
    ).resolves.toMatchObject({
      executableRealpath: target,
      version: "0.145.0",
    });
    expect(calls).toBe(1);
  });

  test("reports an executable miss when every PATH entry is missing or not a directory", async () => {
    const cwd = await directory();
    const missing = join(await directory(), "missing");
    const regularFile = join(await directory(), "not-a-directory");
    await writeFile(regularFile, "not a directory");
    let calls = 0;

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: "codex",
        cwd,
        env: { PATH: [missing, regularFile].join(delimiter) },
        probe: async () => {
          calls += 1;
          return {
            stdout: Buffer.from("codex-cli 0.145.0"),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          };
        },
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      message: "provider executable was not found",
      recoverable: false,
    });
    expect(calls).toBe(0);
  });

  test("fails closed when inspecting a PATH entry returns ELOOP", async () => {
    const cwd = await directory();
    const loopRoot = await directory();
    const loop = join(loopRoot, "loop");
    await symlink("loop", loop);
    const bin = await directory();
    await executable(bin, "codex");
    let calls = 0;

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: "codex",
        cwd,
        env: { PATH: [loop, bin].join(delimiter) },
        probe: async () => {
          calls += 1;
          return {
            stdout: Buffer.from("codex-cli 0.145.0"),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          };
        },
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      message: "provider PATH entry is unavailable",
      recoverable: false,
    });
    expect(calls).toBe(0);
  });

  test.each([undefined, "", `${delimiter}/absolute`])(
    "rejects missing or empty PATH segments before probing: %j",
    async (PATH) => {
      const cwd = await directory();
      const bin = await directory();
      await executable(bin, "codex");
      let calls = 0;

      await expect(
        resolveProviderIdentity({
          provider: "codex",
          executable: "codex",
          cwd,
          env: PATH === undefined ? {} : { PATH },
          probe: async () => {
            calls += 1;
            return {
              stdout: Buffer.from("codex-cli 0.145.0"),
              stderr: Buffer.alloc(0),
              exitCode: 0,
            };
          },
        }),
      ).rejects.toSatisfy(configError);
      expect(calls).toBe(0);
    },
  );

  test("uses the first existing PATH candidate and fails closed when it is not executable", async () => {
    const cwd = await directory();
    const first = await directory();
    const second = await directory();
    const firstCandidate = join(first, "codex");
    await writeFile(firstCandidate, "not executable");
    await executable(second, "codex");
    let calls = 0;

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: "codex",
        cwd,
        env: { PATH: `${first}${delimiter}${second}` },
        probe: async () => {
          calls += 1;
          return {
            stdout: Buffer.from("codex-cli 0.145.0"),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          };
        },
      }),
    ).rejects.toSatisfy(configError);
    expect(calls).toBe(0);
  });

  test("canonicalizes a symlink before probing", async () => {
    const cwd = await directory();
    const target = await realpath(await executable(cwd, "real-claude"));
    await symlink(target, join(cwd, "claude"));

    await expect(
      resolveProviderIdentity({
        provider: "claude",
        executable: "./claude",
        cwd,
        env: {},
        probe: probe("2.1.218 (Claude Code)"),
      }),
    ).resolves.toMatchObject({ executableRealpath: target });
  });

  test("reads only an own data PATH property without enumerating hostile environment keys", async () => {
    const cwd = await directory();
    const bin = await directory();
    await executable(bin, "claude");
    let hostileCalls = 0;
    const env = Object.create(null, {
      PATH: { enumerable: true, value: bin },
      private: {
        enumerable: true,
        get: () => {
          hostileCalls += 1;
          throw new Error("must not read");
        },
      },
    });

    await expect(
      resolveProviderIdentity({
        provider: "claude",
        executable: "claude",
        cwd,
        env,
        probe: probe("2.1.218 (Claude Code)"),
      }),
    ).resolves.toMatchObject({ id: "claude" });
    expect(hostileCalls).toBe(0);
  });

  test("rejects proxied or accessor-backed PATH without invoking traps", async () => {
    const cwd = await directory();
    const sentinel = new Error("environment trap must not run");
    let trapCalls = 0;
    const trapped = () => {
      trapCalls += 1;
      throw sentinel;
    };
    const proxied = new Proxy(
      { PATH: cwd },
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        ownKeys: trapped,
      },
    );
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "PATH", {
      enumerable: true,
      get: trapped,
    });

    for (const env of [proxied, accessor])
      await expect(
        resolveProviderIdentity({
          provider: "codex",
          executable: "codex",
          cwd,
          env,
          probe: probe("codex-cli 0.145.0"),
        }),
      ).rejects.toSatisfy(configError);
    expect(trapCalls).toBe(0);
  });

  test("rejects proxy/accessor top-level options and an inherited probe before any await", async () => {
    const cwd = await directory();
    const target = await executable(cwd, "codex");
    const base = {
      provider: "codex",
      executable: target,
      cwd,
      env: {},
      probe: probe("codex-cli 0.145.0"),
    };
    const proxy = new Proxy(base, {});
    const accessor = { ...base };
    Object.defineProperty(accessor, "probe", {
      enumerable: true,
      get: () => base.probe,
    });
    const inherited = Object.create(
      { probe: base.probe },
      Object.getOwnPropertyDescriptors({
        provider: "codex",
        executable: target,
        cwd,
        env: {},
      }),
    );

    for (const options of [proxy, accessor, inherited]) {
      await expect(resolveProviderIdentity(options)).rejects.toSatisfy(
        configError,
      );
    }
  });

  test("rejects a proxied probe function without invoking it", async () => {
    const cwd = await directory();
    const target = await executable(cwd, "codex");
    let applyCalls = 0;
    const proxiedProbe = new Proxy(probe("codex-cli 0.145.0"), {
      apply: () => {
        applyCalls += 1;
        throw new Error("probe proxy must not run");
      },
    });

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: target,
        cwd,
        env: {},
        probe: proxiedProbe,
      }),
    ).rejects.toSatisfy(configError);
    expect(applyCalls).toBe(0);
  });

  test("snapshots exact probe bytes without invoking typed-array hooks", async () => {
    const cwd = await directory();
    const target = await executable(cwd, "codex");
    const properties: readonly PropertyKey[] = [
      "length",
      "byteLength",
      "byteOffset",
      "buffer",
      Symbol.iterator,
    ];

    for (const stream of ["stdout", "stderr"] as const) {
      for (const property of properties) {
        let hookCalls = 0;
        const hostile = Buffer.from(
          stream === "stdout" ? "codex-cli 0.145.0" : "diagnostic",
        );
        Object.defineProperty(hostile, property, {
          configurable: true,
          get: () => {
            hookCalls += 1;
            throw new Error("typed-array hook must not run");
          },
        });

        await expect(
          resolveProviderIdentity({
            provider: "codex",
            executable: target,
            cwd,
            env: {},
            probe: async () => ({
              stdout:
                stream === "stdout"
                  ? hostile
                  : Buffer.from("codex-cli 0.145.0"),
              stderr: stream === "stderr" ? hostile : Buffer.alloc(0),
              exitCode: 0,
            }),
          }),
        ).resolves.toMatchObject({
          id: "codex",
          version: "0.145.0",
        });
        expect(hookCalls).toBe(0);
      }
    }
  });

  test("rejects custom or proxy-prototype probe byte views without invoking traps", async () => {
    const cwd = await directory();
    const target = await executable(cwd, "codex");
    let trapCalls = 0;
    const trapped = () => {
      trapCalls += 1;
      throw new Error("typed-array prototype trap must not run");
    };
    const hostilePrototype = new Proxy(Buffer.prototype, {
      get: trapped,
      getOwnPropertyDescriptor: trapped,
      getPrototypeOf: trapped,
      ownKeys: trapped,
    });
    const proxyPrototypeBytes = Buffer.from("codex-cli 0.145.0");
    Object.setPrototypeOf(proxyPrototypeBytes, hostilePrototype);
    class CustomBytes extends Uint8Array {}

    for (const stdout of [
      proxyPrototypeBytes,
      new CustomBytes(Buffer.from("codex-cli 0.145.0")),
    ]) {
      await expect(
        resolveProviderIdentity({
          provider: "codex",
          executable: target,
          cwd,
          env: {},
          probe: async () => ({
            stdout,
            stderr: Buffer.alloc(0),
            exitCode: 0,
          }),
        }),
      ).rejects.toSatisfy(configError);
    }
    expect(trapCalls).toBe(0);
  });

  test("enforces independent raw byte limits and fatal complete UTF-8 without leaking probe output", async () => {
    const cwd = await directory();
    const target = await executable(cwd, "codex");
    for (const result of [
      {
        stdout: Buffer.alloc(64 * 1024 + 1, 0x61),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      },
      {
        stdout: Buffer.from("codex-cli 0.145.0"),
        stderr: Buffer.alloc(64 * 1024 + 1, 0x61),
        exitCode: 0,
      },
      {
        stdout: Buffer.from([0xe2, 0x82]),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      },
      {
        stdout: Buffer.from("codex-cli 0.145.0"),
        stderr: Buffer.from([0xe2, 0x82]),
        exitCode: 0,
      },
      {
        stdout: Buffer.from("RAW_SECRET"),
        stderr: Buffer.alloc(0),
        exitCode: 1,
      },
    ]) {
      const failure = await resolveProviderIdentity({
        provider: "codex",
        executable: target,
        cwd,
        env: {},
        probe: async () => result,
      }).catch((error: unknown) => error);
      configError(failure);
      expect(String(failure)).not.toContain("RAW_SECRET");
    }
  });

  test("normalizes only the exact supported trimmed banners and rejects controls, BOM, and foreign versions", async () => {
    const cwd = await directory();
    const codex = await executable(cwd, "codex");
    const claude = await executable(cwd, "claude");
    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: codex,
        cwd,
        env: {},
        probe: probe(" \t codex-cli 0.145.0 \r\nignored"),
      }),
    ).resolves.toMatchObject({ version: "0.145.0" });
    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: codex,
        cwd,
        env: {},
        probe: probe("codex-cli 0.146.0"),
      }),
    ).resolves.toMatchObject({ version: "0.146.0" });
    await expect(
      resolveProviderIdentity({
        provider: "claude",
        executable: claude,
        cwd,
        env: {},
        probe: probe("2.1.218 (Claude Code)"),
      }),
    ).resolves.toMatchObject({ version: "2.1.218" });

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: codex,
        cwd,
        env: {},
        probe: probe("codex-cli 0.145.0\u0001"),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", recoverable: false });
    for (const stdout of [
      "\uFEFFcodex-cli 0.145.0",
      "codex-cli 0.144.0",
      "codex-cli 0.147.0",
      "codex-cli 9.9.9",
    ]) {
      await expect(
        resolveProviderIdentity({
          provider: "codex",
          executable: codex,
          cwd,
          env: {},
          probe: probe(stdout),
        }),
      ).rejects.toMatchObject({
        code: "COMPATIBILITY_ERROR",
        recoverable: false,
      });
    }
    expect(validateNormalizedProviderVersion("codex", "0.145.0")).toBe(
      "0.145.0",
    );
    expect(validateNormalizedProviderVersion("codex", "0.146.0")).toBe(
      "0.146.0",
    );
    for (const version of ["0.144.0", "0.147.0", "9.9.9"]) {
      expect(() =>
        validateNormalizedProviderVersion("codex", version),
      ).toThrowError(AwslError);
    }
    expect(() =>
      validateNormalizedProviderVersion("claude", "9.9.9"),
    ).toThrowError(AwslError);
  });

  test("applies the first-version-line byte and control rules before banner matching", async () => {
    const cwd = await directory();
    const codex = await executable(cwd, "codex");
    const valid = "x".repeat(256);
    const tooLong = "x".repeat(257);

    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: codex,
        cwd,
        env: {},
        probe: probe(valid),
      }),
    ).rejects.toMatchObject({ code: "COMPATIBILITY_ERROR" });
    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: codex,
        cwd,
        env: {},
        probe: probe(tooLong),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(
      resolveProviderIdentity({
        provider: "codex",
        executable: codex,
        cwd,
        env: {},
        probe: probe("codex-cli 0.145.0\u0001"),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
