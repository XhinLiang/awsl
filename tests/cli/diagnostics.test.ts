import { describe, expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";
import { AwslError } from "../../src/core/errors.js";

async function diagnose(error: unknown) {
  let stderr = "";
  const code = await executeCli(["config", "show"], {
    cwd: process.cwd(),
    homeDir: process.cwd(),
    env: {},
    stdin: { isTTY: true, read: async () => "" },
    writeStdout: () => {
      throw error;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  return { code, stderr };
}

describe("CLI persistence diagnostics", () => {
  test("preserves nested provider causes and redacts each message", async () => {
    const error = new AwslError(
      "PERSISTENCE_ERROR",
      "journal failed token=outer-secret",
      {
        recoverable: false,
        cause: new Error("record failed password=middle-secret", {
          cause: new AwslError(
            "PROVIDER_ERROR",
            "Claude protocol error: invalid user event",
            {
              recoverable: false,
            },
          ),
        }),
      },
    );
    const result = await diagnose(error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "PERSISTENCE_ERROR: journal failed token=[REDACTED]",
    );
    expect(result.stderr).toContain("record failed password=[REDACTED]");
    expect(result.stderr).toContain(
      "PROVIDER_ERROR: Claude protocol error: invalid user event",
    );
    expect(result.stderr).not.toContain("outer-secret");
    expect(result.stderr).not.toContain("middle-secret");
  });

  test("preserves unexpected errors and terminates cyclic cause chains", async () => {
    const error = new Error("disk write failed");
    error.cause = error;
    const result = await diagnose(error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PERSISTENCE_ERROR: command failed");
    expect(result.stderr.match(/disk write failed/g)).toHaveLength(1);
  });
});
