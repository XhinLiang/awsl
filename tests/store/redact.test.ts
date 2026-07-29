import { describe, expect, test } from "vitest";
import { redactJson, redactText } from "../../src/store/redact.js";

describe("redaction", () => {
  test("redacts sensitive structure and every string leaf", () => {
    expect(
      redactJson({
        headers: [{ name: "Authorization", value: "Bearer abc" }],
        nested: { COOKIE: "x", text: "https://u:p@example.test/a?token=abc" },
        ordinary: "AWS_SECRET_ACCESS_KEY=abc",
      }),
    ).toEqual(
      expect.objectContaining({
        nested: expect.objectContaining({ COOKIE: "[REDACTED]" }),
        ordinary: expect.stringContaining("[REDACTED]"),
      }),
    );
  });
  test("redacts tuple header pairs and nested extra string fields", () => {
    expect(redactJson(["Authorization", "Bearer secret"])).toEqual([
      "Authorization",
      "[REDACTED]",
    ]);
    expect(
      redactJson({
        h: { name: "token", value: "x", extra: "?session=secret" },
      }),
    ).toEqual(
      expect.objectContaining({
        h: expect.objectContaining({
          value: "[REDACTED]",
          extra: "?session=[REDACTED]",
        }),
      }),
    );
  });
  test("preserves numeric usage metrics without weakening token redaction", () => {
    expect(
      redactJson({
        metrics: {
          inputTokens: 2,
          cachedInputTokens: 1,
          outputTokens: 3,
          reasoningTokens: 4,
          attemptOutputTokens: 3,
          totalTokens: 10,
        },
        accessToken: "secret",
        token: "secret",
      }),
    ).toEqual({
      metrics: {
        inputTokens: 2,
        cachedInputTokens: 1,
        outputTokens: 3,
        reasoningTokens: 4,
        attemptOutputTokens: 3,
        totalTokens: 10,
      },
      accessToken: "[REDACTED]",
      token: "[REDACTED]",
    });
    expect(
      redactJson({
        outputTokens: 7,
        result: { outputTokens: 8 },
        usage: { outputTokens: 9 },
        metrics: { outputTokens: "not-a-metric" },
      }),
    ).toEqual({
      outputTokens: "[REDACTED]",
      result: { outputTokens: "[REDACTED]" },
      usage: { outputTokens: 9 },
      metrics: { outputTokens: "[REDACTED]" },
    });
  });
  test("does not treat ordinary uses of basic as credentials", () => {
    expect(redactText("basic workflow")).toBe("basic workflow");
    expect(redactText("Basic authentication is supported")).toBe(
      "Basic authentication is supported",
    );
  });
  test("redacts a bare valid Basic authorization credential", () => {
    expect(redactText("retrying Basic dXNlcjpwYXNz")).toBe(
      "retrying Basic [REDACTED]",
    );
  });
  test.each([
    "Authorization: Bearer abc",
    "provider error: Authorization: Bearer embedded-secret",
    "retrying Bearer bare-secret",
    "provider error: Cookie: session=embedded-cookie",
    "provider error: Authorization=Basic basic-secret",
    "provider error: Proxy-Authorization=Basic proxy-secret",
    "provider error: Cookie=session=equals-cookie; Path=/",
    "token: colon-secret",
    'password: "quoted-sensitive-value"',
    "api_key : key-secret",
    "credential=credential-secret",
    "client_secret=oauth-client-secret",
    "https://user:url-password-secret@example.test/x?token=abc&amp;key=def",
    "token%3Dabc",
    "X-Amz-Credential=abc&X-Amz-Signature=def",
    "AWS_SESSION_TOKEN=abc",
  ])("removes secret text %s", (text) =>
    expect(redactText(text)).not.toMatch(
      /abc|def|url-password-secret|embedded-secret|bare-secret|embedded-cookie|basic-secret|proxy-secret|equals-cookie|colon-secret|quoted-sensitive-value|key-secret|credential-secret|oauth-client-secret/,
    ),
  );
});
