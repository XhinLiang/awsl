import { Buffer } from "node:buffer";

const REDACTED = "[REDACTED]";
const sensitiveKey =
  /authorization|proxy-authorization|cookie|token|secret|password|credential|signature|(?:api[-_]?)?key|access[-_]?key/i;
const secretParam = /([?&;]|&amp;)([^=&#;]+)=([^&#;\s]*)/gi;
const usageMetricKeys = new Set([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "attemptOutputTokens",
  "totalTokens",
]);
const usageContainerKeys = new Set(["metrics", "usage"]);

function isUsageMetric(
  parentKey: string | undefined,
  key: string,
  value: unknown,
): boolean {
  return (
    parentKey !== undefined &&
    usageContainerKeys.has(parentKey) &&
    usageMetricKeys.has(key) &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function redactText(input: string): string {
  let text = input;
  text = text.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*([:=])\s*[^\r\n]*/gi,
    `$1$2 ${REDACTED}`,
  );
  text = text.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
  text = text.replace(
    /\b(Basic)\s+([A-Za-z0-9+/]+={0,2})(?=$|[^A-Za-z0-9+/=])/gi,
    (match, scheme: string, encoded: string) => {
      const decoded = Buffer.from(encoded, "base64");
      const canonical = decoded.toString("base64").replace(/=+$/u, "");
      if (
        canonical !== encoded.replace(/=+$/u, "") ||
        !decoded.includes(":".charCodeAt(0))
      )
        return match;
      return `${scheme} ${REDACTED}`;
    },
  );
  text = text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
    `$1${REDACTED}@`,
  );
  text = text.replace(
    secretParam,
    (_all, prefix: string, rawName: string) =>
      `${prefix}${rawName}=${REDACTED}`,
  );
  text = text.replace(
    /\b(AWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN|ACCESS_KEY_ID)|X-Amz-(?:Credential|Security-Token|Signature))\s*[=:]\s*[^\s&#;]+/gi,
    `$1=${REDACTED}`,
  );
  text = text.replace(
    /\b((?:access[-_]?|refresh[-_]?)?token|client[-_]?secret|secret|password|credential|signature|api[-_]?key)\s*(?:=|:|%3d)\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s&#;,}\]]+)/gi,
    `$1=${REDACTED}`,
  );
  return text;
}

function redactValue(value: unknown, parentKey?: string): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      sensitiveKey.test(value[0])
    )
      return [value[0], REDACTED];
    return value.map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const pair = entry as Record<string, unknown>;
        const name =
          typeof pair.name === "string"
            ? pair.name
            : typeof pair.key === "string"
              ? pair.key
              : undefined;
        if (name !== undefined && sensitiveKey.test(name))
          return redactValue({ ...pair, value: REDACTED });
      }
      return redactValue(entry);
    });
  }
  const objectValue = value as Record<string, unknown>;
  const pairName =
    typeof objectValue.name === "string"
      ? objectValue.name
      : typeof objectValue.key === "string"
        ? objectValue.key
        : undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(objectValue))
    result[key] =
      key === "value" && pairName !== undefined && sensitiveKey.test(pairName)
        ? REDACTED
        : sensitiveKey.test(key) && !isUsageMetric(parentKey, key, entry)
          ? REDACTED
          : redactValue(entry, key);
  return result;
}

export function redactJson(value: unknown): unknown {
  return redactValue(value);
}

export { REDACTED };
