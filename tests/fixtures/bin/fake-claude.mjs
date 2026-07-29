#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("2.1.218 (Claude Code)\n");
  process.exit(0);
}
const mcpFlag = argv.indexOf("--mcp-config");
const mcpPath = mcpFlag === -1 ? undefined : argv[mcpFlag + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.AWSL_FAKE_CLAUDE_CAPTURE) {
  await appendFile(
    process.env.AWSL_FAKE_CLAUDE_CAPTURE,
    `${JSON.stringify({ argv, prompt })}\n`,
  );
}
const fixture = prompt.startsWith("fixture:")
  ? prompt.slice("fixture:".length)
  : "success";

const emit = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const init = (overrides = {}) => ({
  type: "system",
  subtype: "init",
  session_id: "session-1",
  model: "claude-resolved-2.1.218",
  ...overrides,
});

const assistant = (overrides = {}) => ({
  type: "assistant",
  session_id: "session-1",
  message: {
    type: "message",
    role: "assistant",
    model: "claude-resolved-2.1.218",
    content: [{ type: "text", text: "intermediate" }],
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 1,
      output_tokens: 4,
    },
  },
  ...overrides,
});

const result = (overrides = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "session-1",
  result: "ok",
  usage: {
    input_tokens: 11,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 1,
    output_tokens: 7,
  },
  ...overrides,
});

switch (fixture) {
  case "success":
    emit(init());
    emit(assistant());
    emit(result());
    break;
  case "structured":
    emit(init());
    emit(
      assistant({
        message: {
          type: "message",
          role: "assistant",
          model: "claude-resolved-2.1.218",
          content: [
            {
              type: "tool_use",
              id: "structured-1",
              name: "StructuredOutput",
              input: {},
            },
          ],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      }),
    );
    emit(
      assistant({
        message: {
          type: "message",
          role: "assistant",
          model: "claude-resolved-2.1.218",
          content: [
            {
              type: "tool_use",
              id: "structured-2",
              name: "StructuredOutput",
              input: {},
            },
          ],
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      }),
    );
    emit(
      result({
        result: '{"answer":42}',
        structured_output: { answer: 42 },
        usage: { input_tokens: 10, output_tokens: 6 },
      }),
    );
    break;
  case "structured-too-many-attempts":
    emit(init());
    for (let index = 1; index <= 6; index += 1) {
      emit(
        assistant({
          message: {
            type: "message",
            role: "assistant",
            model: "claude-resolved-2.1.218",
            content: [
              {
                type: "tool_use",
                id: `structured-${index}`,
                name: "StructuredOutput",
                input: {},
              },
            ],
            usage: { input_tokens: index, output_tokens: 1 },
          },
        }),
      );
    }
    emit(result({ structured_output: { answer: 42 } }));
    break;
  case "success-is-error":
    emit(init());
    emit(
      result({
        is_error: true,
        result: "terminal API error",
        usage: { input_tokens: 9, output_tokens: 5 },
      }),
    );
    break;
  case "tool-loop":
    emit(init());
    emit(
      assistant({
        message: {
          type: "message",
          role: "assistant",
          model: "claude-resolved-2.1.218",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      }),
    );
    emit({
      type: "stream_event",
      session_id: "session-1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "x" },
      },
    });
    emit({
      type: "user",
      session_id: "session-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "contents",
          },
        ],
      },
    });
    emit({
      type: "tool_progress",
      session_id: "session-1",
      tool_use_id: "tool-1",
      tool_name: "Read",
      elapsed_time_seconds: 1,
    });
    emit({
      type: "tool_use_summary",
      session_id: "session-1",
      summary: "Read README.md",
      preceding_tool_use_ids: ["tool-1"],
    });
    emit({
      type: "rate_limit_event",
      session_id: "session-1",
      rate_limit_info: { status: "allowed" },
    });
    emit({
      type: "auth_status",
      session_id: "session-1",
      isAuthenticating: false,
      output: [],
    });
    emit({
      type: "prompt_suggestion",
      session_id: "session-1",
      suggestion: "Continue",
    });
    emit(result());
    break;
  case "unknown-event":
    emit(init());
    emit({ type: "future_event", session_id: "session-1" });
    emit(result());
    break;
  case "duplicate-terminal":
    emit(init());
    emit(result());
    emit(result());
    break;
  case "post-terminal":
    emit(init());
    emit(result());
    emit(assistant());
    break;
  case "system-non-init":
    emit({ type: "system", subtype: "status", session_id: "session-1" });
    emit(result());
    break;
  case "user-non-tool-result":
    emit(init());
    emit({
      type: "user",
      session_id: "session-1",
      message: { role: "user", content: [{ type: "text", text: "echo" }] },
    });
    emit(result());
    break;
  case "conflicting-session":
    emit(init());
    emit(result({ session_id: "session-2" }));
    break;
  case "conflicting-model":
    emit(init({ model: "model-a" }));
    emit(
      assistant({
        message: {
          type: "message",
          role: "assistant",
          model: "model-b",
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    emit(result());
    break;
  case "eof-without-terminal":
    emit(init());
    emit(assistant());
    break;
  case "malformed-json":
    process.stdout.write('{"type":"system"\n');
    break;
  case "terminal-then-malformed":
    emit(init());
    emit(result());
    process.stdout.write('{"type":"broken"\n');
    break;
  case "nonzero-exit":
    emit(init());
    emit(assistant());
    process.stderr.write("sensitive provider detail");
    process.exitCode = 3;
    break;
  case "missing-output-usage":
    emit(init());
    emit(result({ usage: { input_tokens: 2 } }));
    break;
  case "invalid-output-usage":
    emit(init());
    emit(result({ usage: { input_tokens: 2, output_tokens: "7" } }));
    break;
  case "argv": {
    const mcpPacket =
      mcpPath === undefined ? undefined : await readFile(mcpPath, "utf8");
    emit(init());
    emit(
      result({
        result: JSON.stringify({
          argv,
          cwd: process.cwd(),
          mcpPacket,
          prompt,
        }),
        structured_output: { ok: true },
      }),
    );
    break;
  }
  case "unreachable":
    process.stderr.write("fixture must not be launched");
    process.exitCode = 97;
    break;
  case "hang":
    emit(init({ mcp_path: mcpPath }));
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
    break;
  default:
    if (fixture.startsWith("error:")) {
      emit(init());
      emit(
        result({
          subtype: fixture.slice("error:".length),
          is_error: true,
          result: "provider failed",
          errors: ["provider failed"],
          usage: { input_tokens: 13, output_tokens: 3 },
        }),
      );
    } else {
      process.stderr.write(`unknown fake Claude fixture: ${fixture}`);
      process.exitCode = 98;
    }
}
