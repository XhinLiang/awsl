export function safeDiagnosticValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "<redacted>";
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  )
    return String(value);
  return value && typeof value === "object" ? "<redacted>" : "<unprintable>";
}
