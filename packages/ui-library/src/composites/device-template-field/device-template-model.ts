import { holdVarSlots, templateCapKey } from '@camstack/types'

/** What a field of the text may hold: the declared value kind of the place the template feeds. */
export type DeviceTemplateAccepts = 'number' | 'string' | 'boolean' | 'any'

/** A field kind as `getWireableFields` reports it. */
export type DeviceFieldKind = 'string' | 'number' | 'boolean' | 'enum'

/**
 * A number slot takes numbers, a yes/no slot takes booleans; a text slot prints
 * anything, so it takes every kind (a temperature in a sentence is the common case).
 * An unknown kind is never offered to a typed slot.
 */
export function fieldAccepts(accepts: DeviceTemplateAccepts, kind: string): boolean {
  if (accepts === 'any' || accepts === 'string') return true
  return kind === accepts
}

export type TemplateSegment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'ref'
      /** The token exactly as written, filters included. */
      readonly raw: string
      readonly alias: string
      /** The path after the alias, as written (`temperature`, `climate.temperature`). */
      readonly path: string
    }

/** Names the run-time owns besides devices: `{{vars.x}}` is a variable slot, never a device. */
const NON_DEVICE_HEADS: ReadonlySet<string> = new Set(['vars'])

const REF_PATTERN = /\{\{\s*([a-z][a-z0-9_]*)\.([^\s|}]+)\s*(?:\|[^}]*)?\}\}/g

/** Split a template into text and device references; the pieces re-join to the input. */
export function parseTemplateSegments(text: string): readonly TemplateSegment[] {
  const segments: TemplateSegment[] = []
  let last = 0
  for (const match of text.matchAll(REF_PATTERN)) {
    const [raw, alias, path] = match
    if (alias === undefined || path === undefined || NON_DEVICE_HEADS.has(alias)) continue
    if (match.index > last) segments.push({ kind: 'text', text: text.slice(last, match.index) })
    segments.push({ kind: 'ref', raw, alias, path })
    last = match.index + raw.length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}

export function hasDeviceRefs(text: string): boolean {
  return parseTemplateSegments(text).some((s) => s.kind === 'ref')
}

/** One cap of the device and the first path segments its fields start with. */
export interface DeviceCapFields {
  readonly cap: string
  readonly paths: readonly string[]
}

function head(path: string): string {
  return path.split('.')[0] ?? path
}

/**
 * The token for one value. The short form `{{ alias.field }}` resolves only when exactly one
 * cap of the device carries a field of that name; otherwise the cap is spelled out
 * (`{{ alias.cap_name.field }}`), as the renderer requires.
 */
export function deviceTemplateToken(
  alias: string,
  pick: { readonly cap: string; readonly path: string },
  caps: readonly DeviceCapFields[],
): string {
  const field = head(pick.path)
  const owners = caps.filter((c) => c.paths.some((p) => head(p) === field))
  const ambiguous = owners.some((c) => c.cap !== pick.cap)
  return ambiguous
    ? `{{ ${alias}.${templateCapKey(pick.cap)}.${pick.path} }}`
    : `{{ ${alias}.${pick.path} }}`
}

export interface TemplateSelection {
  readonly start: number
  readonly end: number
}

export interface TemplateInsertion {
  readonly value: string
  readonly cursor: number
}

/** Put `token` at the selection (replacing it), clamped to the text. */
export function insertTemplateToken(
  value: string,
  selection: TemplateSelection,
  token: string,
): TemplateInsertion {
  const start = Math.min(Math.max(selection.start, 0), value.length)
  const end = Math.min(Math.max(selection.end, start), value.length)
  return {
    value: `${value.slice(0, start)}${token}${value.slice(end)}`,
    cursor: start + token.length,
  }
}

/** A chip's label: the alias and the path, without braces or filters. */
export function chipLabel(segment: Extract<TemplateSegment, { kind: 'ref' }>): string {
  return `${segment.alias}.${segment.path}`
}

/**
 * Which `{{…}}` the consumer fills itself, so the hub is not asked about them:
 *  - `vars` (default): only `{{ vars.name }}`, the one slot an action run holds (`holdVarSlots`);
 *  - `placeholders`: also a bare `{{name}}`, the notification text variables.
 */
export type DeviceTemplateHeldSlots = 'vars' | 'placeholders'

const PLACEHOLDER_SLOT = /\{\{\s*(?:vars\.)?\w+\s*\}\}/g

/** What the hub is asked to vet: the text with the consumer's own slots set aside, as the run-time does. */
export function textForDeviceCheck(text: string, held: DeviceTemplateHeldSlots = 'vars'): string {
  return held === 'placeholders' ? text.replace(PLACEHOLDER_SLOT, '·') : holdVarSlots(text, '·')
}

/** True when the text carries template markup beyond the consumer's own slots. */
export function carriesDeviceTemplate(
  text: string,
  held: DeviceTemplateHeldSlots = 'vars',
): boolean {
  return /\{\{|\{%/.test(textForDeviceCheck(text, held))
}
