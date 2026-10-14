// Input hygiene for every incoming string (CLAUDE.md § Coding conventions). Runs before validation
// and storage, so lone surrogates, NUL bytes and look-alike encodings never reach zod, Postgres or
// the model. The DB CHECKs on briefs reject the same control characters.

// C0 controls except \t (U+0009) and \n (U+000A), DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Well-formed UTF-16, no control characters except \n and \t, NFC. */
export function sanitizeText(value: string): string {
  return value.toWellFormed().replace(CONTROL, '').normalize('NFC');
}

/** sanitizeText on every string in a JSON value, keys included. Other values pass through. */
export function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeText(k), sanitizeDeep(v)]));
  }
  return value;
}
