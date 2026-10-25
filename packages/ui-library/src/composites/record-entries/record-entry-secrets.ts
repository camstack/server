import { REDACTED_SECRET } from '@camstack/types'

/** Whether a record entry field still holds the redaction token from a read. */
export function isRedactedSecret(value: unknown): value is typeof REDACTED_SECRET {
  return value === REDACTED_SECRET
}

/** Text shown in a password box for a redacted stored secret (empty — placeholder carries the hint). */
export function secretDisplayValue(value: unknown): string {
  if (isRedactedSecret(value)) return ''
  return typeof value === 'string' ? value : ''
}

/** Merge an edited password box back into the body sent to `putEntry`. */
export function mergeSecretForSubmit(draft: string, original: unknown): unknown {
  if (!isRedactedSecret(original)) return draft
  if (draft.length === 0) return REDACTED_SECRET
  return draft
}

/** Is this JSON-schema leaf (or path) a credential field? */
export function isSecretField(
  path: string,
  secretPaths: readonly string[],
  schemaNode: Record<string, unknown>,
): boolean {
  if (schemaNode['secret'] === true) return true
  return secretPaths.includes(path)
}
