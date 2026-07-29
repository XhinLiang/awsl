import { parseDocument } from "yaml";

/**
 * Parses strict JSON while rejecting duplicate keys at every depth. Parser
 * diagnostics are deliberately discarded so callers can expose bounded errors.
 */
export function parseUniqueJson(source: string): unknown {
  try {
    const value: unknown = JSON.parse(source);
    const document = parseDocument(source, {
      version: "1.2",
      schema: "json",
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
    });
    if (document.errors.length > 0 || document.warnings.length > 0)
      throw new TypeError();
    return value;
  } catch {
    throw new TypeError("invalid unique JSON");
  }
}
