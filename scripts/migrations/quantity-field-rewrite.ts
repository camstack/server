/**
 * The pure half of the quantity-field migration: rewrite the `(cap, field)`
 * references inside a stored JSON value, and count them.
 *
 * ONE walker serves both jobs. A count is the same walk with the result thrown
 * away, so "before" and "after" figures cannot disagree with what a rewrite
 * actually touches.
 *
 * A reference is rewritten ONLY when its capability matches the map. Cap names
 * are shared and field names are not unique across caps, so nothing here ever
 * looks at a field name alone: `battery.volts` and `power-meter.volts` are two
 * different pairs, and `weather.temperature` is not in the map at all.
 *
 * The stored shapes it recognises (each found by reading the code that writes
 * it, see `docs/architecture/storage-files.md` § Offline migrations):
 *
 *  A. `{ cap, fieldPath }`        compositions (`from`, `aggregate.reads`,
 *     `series.read`, expression `from` bindings), helper members, recipe
 *     conditions and `device-state` triggers, expression field/global bindings.
 *  B. `{ capName, valuePath }`    OSD manager `device-state` sources and
 *     named-template bindings.
 *  C. `{ kind: 'fields', cap, fields }`   a composition / customization
 *     feature: the KEYS of `fields` are the target cap's own fields.
 *  D. a runtime-state blob `{ <cap>: { <field>: value }, $owned: … }`, handled
 *     by {@link rewriteRuntimeBlob} (the slices and the D663 claims).
 */
import {
  DROPPED_FIELDS,
  isDroppedField,
  isNewFieldName,
  QUANTITY_FIELD_RENAMES,
  renamedField,
  renamedFieldPath,
  splitFieldPath,
} from './quantity-field-renames.ts'

/** `<cap>.<field>` → how many times a stored reference names it. */
export type Tally = Map<string, number>

export interface RewriteSink {
  /** References to a renamed field (old OR new name) or to a dropped one. */
  readonly seen: Tally
  /** `<cap>.<newField>` → references that collapsed into an existing new-name entry. */
  readonly merged: Tally
  /** Things the migration cannot rewrite but the operator should look at. */
  readonly advisories: Tally
}

export function newSink(): RewriteSink {
  return { seen: new Map(), merged: new Map(), advisories: new Map() }
}

export function bump(tally: Tally, key: string, by = 1): void {
  tally.set(key, (tally.get(key) ?? 0) + by)
}

export function refKey(cap: string, field: string): string {
  return `${cap}.${field}`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The row key under which a device's field claims travel (D663). */
export const OWNED_FIELDS_KEY = '$owned'

function noteField(sink: RewriteSink, cap: string, field: string): void {
  if (renamedField(cap, field) !== null || isNewFieldName(cap, field) || isDroppedField(cap, field))
    bump(sink.seen, refKey(cap, field))
}

/**
 * Rename the keys of `obj`, a map of `cap`'s fields. A key whose new name is
 * already present is dropped and the existing value wins, counted in `merged`.
 * Returns the same object when nothing changes.
 */
export function renameFieldKeys(
  cap: string,
  obj: Readonly<Record<string, unknown>>,
  sink: RewriteSink,
): Record<string, unknown> | Readonly<Record<string, unknown>> {
  if (QUANTITY_FIELD_RENAMES[cap] === undefined && DROPPED_FIELDS[cap] === undefined) return obj
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [key, value] of Object.entries(obj)) {
    noteField(sink, cap, key)
    const to = renamedField(cap, key)
    if (to === null) {
      out[key] = value
      continue
    }
    changed = true
    if (Object.hasOwn(obj, to)) {
      bump(sink.merged, refKey(cap, to))
      continue
    }
    out[to] = value
  }
  return changed ? out : obj
}

function rewriteFieldPath(cap: string, path: string, sink: RewriteSink): string {
  noteField(sink, cap, splitFieldPath(path).field)
  return renamedFieldPath(cap, path) ?? path
}

function rewriteClaimFields(
  cap: string,
  fields: readonly unknown[],
  sink: RewriteSink,
): readonly unknown[] {
  const out: unknown[] = []
  let changed = false
  for (const entry of fields) {
    if (typeof entry !== 'string') {
      out.push(entry)
      continue
    }
    noteField(sink, cap, entry)
    const to = renamedField(cap, entry)
    if (to === null) {
      out.push(entry)
      continue
    }
    changed = true
    if (fields.includes(to) || out.includes(to)) {
      bump(sink.merged, refKey(cap, to))
      continue
    }
    out.push(to)
  }
  return changed ? out : fields
}

/**
 * A device's runtime-state row: `{ <capName>: slice, $owned: { <capName>: claim } }`.
 * The slice keys and the claim's `fields` / `values` are renamed for the caps in
 * the map; every other cap is returned untouched.
 */
export function rewriteRuntimeBlob(blob: unknown, sink: RewriteSink): unknown {
  if (!isRecord(blob)) return blob
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [key, value] of Object.entries(blob)) {
    if (key === OWNED_FIELDS_KEY) {
      const owned = rewriteOwnedClaims(value, sink)
      changed = changed || owned !== value
      out[key] = owned
      continue
    }
    if (!isRecord(value)) {
      out[key] = value
      continue
    }
    const slice = renameFieldKeys(key, value, sink)
    changed = changed || slice !== value
    out[key] = slice
  }
  return changed ? out : blob
}

function rewriteOwnedClaims(owned: unknown, sink: RewriteSink): unknown {
  if (!isRecord(owned)) return owned
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [cap, claim] of Object.entries(owned)) {
    if (!isRecord(claim)) {
      out[cap] = claim
      continue
    }
    const fields = Array.isArray(claim['fields'])
      ? rewriteClaimFields(cap, claim['fields'], sink)
      : claim['fields']
    const values = isRecord(claim['values'])
      ? renameFieldKeys(cap, claim['values'], sink)
      : claim['values']
    if (fields === claim['fields'] && values === claim['values']) {
      out[cap] = claim
      continue
    }
    changed = true
    out[cap] = { ...claim, fields, values }
  }
  return changed ? out : owned
}

const OLD_NAME_PATTERNS: readonly {
  readonly name: string
  readonly pattern: RegExp
}[] = [
  ...new Set(Object.values(QUANTITY_FIELD_RENAMES).flatMap((fields) => Object.keys(fields))),
].map((name) => ({ name, pattern: new RegExp(`\\b${name}\\b`) }))

/** Free code cannot be rewritten safely: count which old names it still mentions. */
function noteCodeMentions(code: string, sink: RewriteSink): void {
  for (const { name, pattern } of OLD_NAME_PATTERNS) {
    if (pattern.test(code)) bump(sink.advisories, `code mentions ${name}`)
  }
}

/** A `cap` action's `args` are method arguments, not fields: report an old-name key. */
function noteActionArgs(
  cap: string,
  args: Readonly<Record<string, unknown>>,
  sink: RewriteSink,
): void {
  for (const key of Object.keys(args)) {
    if (renamedField(cap, key) !== null) bump(sink.advisories, `action arg ${refKey(cap, key)}`)
  }
}

function walkArray(items: readonly unknown[], sink: RewriteSink): readonly unknown[] {
  let changed = false
  const out = items.map((item) => {
    const next = walk(item, sink)
    changed = changed || next !== item
    return next
  })
  return changed ? out : items
}

/** Sites A, B and C on one object, before its children are visited. */
function rewriteSites(obj: Record<string, unknown>, sink: RewriteSink): Record<string, unknown> {
  let out = obj
  const cap = obj['cap']
  const fieldPath = obj['fieldPath']
  if (typeof cap === 'string' && typeof fieldPath === 'string') {
    const next = rewriteFieldPath(cap, fieldPath, sink)
    if (next !== fieldPath) out = { ...out, fieldPath: next }
  }
  const capName = obj['capName']
  const valuePath = obj['valuePath']
  if (typeof capName === 'string' && typeof valuePath === 'string') {
    const next = rewriteFieldPath(capName, valuePath, sink)
    if (next !== valuePath) out = { ...out, valuePath: next }
  }
  const fields = obj['fields']
  if (obj['kind'] === 'fields' && typeof cap === 'string' && isRecord(fields)) {
    const next = renameFieldKeys(cap, fields, sink)
    if (next !== fields) out = { ...out, fields: next }
  }
  if (obj['kind'] === 'cap' && typeof cap === 'string' && isRecord(obj['args'])) {
    noteActionArgs(cap, obj['args'], sink)
  }
  return out
}

/** Walk any stored JSON value; the same value is returned when nothing changes. */
export function walk(value: unknown, sink: RewriteSink): unknown {
  if (Array.isArray(value)) return walkArray(value, sink)
  if (!isRecord(value)) return value
  const sited = rewriteSites(value, sink)
  let copy: Record<string, unknown> | null = null
  for (const [key, child] of Object.entries(sited)) {
    if (key === 'code' && typeof child === 'string') noteCodeMentions(child, sink)
    const next = walk(child, sink)
    if (next === child) continue
    copy = copy ?? { ...sited }
    copy[key] = next
  }
  return copy ?? sited
}

/**
 * The tally and the rewritten value of one stored JSON text. `rewritten` is
 * null when the text is not JSON or nothing in it changes.
 */
export interface RowRewrite {
  readonly rewritten: string | null
}

export function rewriteJsonText(
  text: string,
  sink: RewriteSink,
  rewrite: (parsed: unknown, sink: RewriteSink) => unknown,
): RowRewrite {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { rewritten: null }
  }
  const next = rewrite(parsed, sink)
  return { rewritten: next === parsed ? null : JSON.stringify(next) }
}
