/**
 * Display names of IMPORTED models (registry rows: plus catalog, plus catalog,
 * plugin catalog, custom uploads and conversions). The name lives on the registry
 * row (`entry.name`) — there is no second store — and it never touches the
 * model id, so pins and availability are unaffected by a rename. CamStack's
 * own catalog models are not renameable.
 *
 * Shared by the hub action (validation) and the page (field + resolver).
 */

/** Longest display name accepted, after trimming. */
export const MODEL_DISPLAY_NAME_MAX = 80

export type DisplayNameEdit =
  | { readonly kind: 'set'; readonly name: string }
  /** Empty input: go back to the name the model was imported with. */
  | { readonly kind: 'reset' }

export type DisplayNameParse =
  | DisplayNameEdit
  | {
      readonly kind: 'invalid'
      readonly reason: string
      /** Machine-readable cause, so a UI can word it in the operator's language. */
      readonly code: 'control' | 'too-long'
      readonly length: number
    }

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Whitespace runs collapse to one space; leading/trailing whitespace goes. */
export function parseDisplayName(raw: string): DisplayNameParse {
  const name = raw.replace(/\s+/g, ' ').trim()
  if (name.length === 0) return { kind: 'reset' }
  if (CONTROL_CHARS.test(name)) {
    return {
      kind: 'invalid',
      reason: 'The name contains control characters.',
      code: 'control',
      length: name.length,
    }
  }
  if (name.length > MODEL_DISPLAY_NAME_MAX) {
    return {
      kind: 'invalid',
      reason: `The name is ${name.length} characters long; the limit is ${MODEL_DISPLAY_NAME_MAX}.`,
      code: 'too-long',
      length: name.length,
    }
  }
  return { kind: 'set', name }
}

/**
 * The optional display name typed on an import card: `undefined` when left
 * empty (the source's own default applies), the cleaned name otherwise.
 * Throws with the reason when the input is not acceptable.
 */
export function optionalImportName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const parsed = parseDisplayName(raw)
  if (parsed.kind === 'invalid') throw new Error(`Display name rejected: ${parsed.reason}`)
  return parsed.kind === 'set' ? parsed.name : undefined
}

/** The ONE place a model's shown name is decided: its name, else its id. */
export function resolveModelDisplayName(entry: {
  readonly id: string
  readonly name?: string
}): string {
  const name = entry.name?.trim() ?? ''
  return name.length > 0 ? name : entry.id
}
