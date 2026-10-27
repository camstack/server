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
 *  E. `{ cap, targetId }`          a Customize target (the target id IS the field).
 *  F. `{ cap, method, args }`      a stored call: the argument keys that follow a
 *     rename, addressed by (cap, method) only.
 *  G. `{ cap, event, payload }`    a stored event payload, addressed by (cap, event).
 *  H. provider configs keyed by a cap's field names (`meterEntities`, `meter`,
 *     `slots`, `slotUnits`), found by their sibling keys.
 *  I. a bare `<cap>.<field>` text, as a value or an object key.
 */
import {
  DROPPED_FIELDS,
  EVENT_PAYLOAD_RENAMES,
  isDroppedField,
  isNewFieldName,
  METHOD_ARG_RENAMES,
  parseQualifiedText,
  PROVIDER_CONFIG_SITES,
  QUANTITY_FIELD_RENAMES,
  type CapFieldRenames,
  type ProviderConfigSite,
  renamedField,
  renamedFieldPath,
  renamedQualifiedText,
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
  /**
   * Old-name keys renamed inside a context, `<what> <old> -> <new>` → count (a
   * method's arguments, an event payload, a provider config). After a rewrite
   * none is left.
   */
  readonly rewrites: Tally
  /** `<cap>.<field>` → stored values the code no longer has, deleted. */
  readonly dropped: Tally
  /** `<cap>.<field>` → entries that ARRIVED from a re-homed field (history). */
  readonly moved: Tally
}

export function newSink(): RewriteSink {
  return {
    seen: new Map(),
    merged: new Map(),
    advisories: new Map(),
    rewrites: new Map(),
    dropped: new Map(),
    moved: new Map(),
  }
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

/**
 * Rename the keys of `obj` that `renames` names, counting each under `what`
 * (`<cap>.<method> arg`). A new name already present wins; the old key goes.
 */
function renameContextKeys(
  what: string,
  renames: CapFieldRenames,
  obj: Readonly<Record<string, unknown>>,
  sink: RewriteSink,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [key, value] of Object.entries(obj)) {
    const to = renames[key]
    if (to === undefined) {
      out[key] = value
      continue
    }
    changed = true
    bump(sink.rewrites, `${what} ${key} -> ${to}`)
    if (!Object.hasOwn(obj, to)) out[to] = value
  }
  return changed ? out : obj
}

/**
 * Delete the keys of `cap` the code re-homed on another cap (the value is
 * repopulated by its owner from the new cap), counting each as dropped.
 */
function dropRelocatedKeys(
  cap: string,
  obj: Readonly<Record<string, unknown>>,
  sink: RewriteSink,
): Readonly<Record<string, unknown>> {
  if (DROPPED_FIELDS[cap] === undefined) return obj
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [key, value] of Object.entries(obj)) {
    if (isDroppedField(cap, key)) {
      changed = true
      bump(sink.dropped, refKey(cap, key))
      continue
    }
    out[key] = value
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
    if (isDroppedField(cap, entry)) {
      changed = true
      bump(sink.dropped, refKey(cap, entry))
      continue
    }
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
    const slice = dropRelocatedKeys(key, renameFieldKeys(key, value, sink), sink)
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
      ? dropRelocatedKeys(cap, renameFieldKeys(cap, claim['values'], sink), sink)
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

interface CodeOperation {
  readonly label: string
  readonly name: RegExp
  readonly oldKeys: readonly RegExp[]
}

function keyPatterns(renames: CapFieldRenames): readonly RegExp[] {
  return Object.keys(renames).map((key) => new RegExp(`\\b${key}\\b`))
}

/** Every `(cap, method)` and `(cap, event)` whose arguments or payload follow a rename. */
const CODE_OPERATIONS: readonly CodeOperation[] = [
  ...Object.entries(METHOD_ARG_RENAMES).flatMap(([cap, methods]) =>
    Object.entries(methods).map(([method, renames]) => ({
      label: `${cap}.${method}`,
      name: new RegExp(`\\b${method}\\b`),
      oldKeys: keyPatterns(renames),
    })),
  ),
  ...Object.entries(EVENT_PAYLOAD_RENAMES).flatMap(([cap, events]) =>
    Object.entries(events).map(([event, rename]) => ({
      label: `${cap}.${event}`,
      name: new RegExp(`\\b${event}\\b`),
      oldKeys: keyPatterns(rename.renames),
    })),
  ),
]

/** Free code cannot be rewritten safely: count which old names it still mentions. */
function noteCodeMentions(code: string, sink: RewriteSink): void {
  for (const { name, pattern } of OLD_NAME_PATTERNS) {
    if (pattern.test(code)) bump(sink.advisories, `code mentions ${name}`)
  }
  for (const op of CODE_OPERATIONS) {
    if (op.name.test(code) && op.oldKeys.some((key) => key.test(code)))
      bump(sink.advisories, `code uses ${op.label} with an old key`)
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

/** Site F: a stored call `{ cap, method, args }` whose method is in the map. */
function rewriteCallArgs(obj: Record<string, unknown>, sink: RewriteSink): Record<string, unknown> {
  const cap = obj['cap']
  const method = obj['method']
  const args = obj['args']
  if (typeof cap !== 'string' || typeof method !== 'string' || !isRecord(args)) return obj
  const renames = METHOD_ARG_RENAMES[cap]?.[method]
  if (renames === undefined) {
    if (obj['kind'] === 'cap') noteActionArgs(cap, args, sink)
    return obj
  }
  const next = renameContextKeys(`${cap}.${method} arg`, renames, args, sink)
  return next === args ? obj : { ...obj, args: next }
}

/** The cap and event name of a stored event reference, or null. */
function eventRef(obj: Readonly<Record<string, unknown>>): { cap: string; event: string } | null {
  const named = obj['event'] ?? obj['eventName']
  if (typeof named !== 'string') return null
  const cap = obj['cap'] ?? obj['capName']
  if (typeof cap === 'string') return { cap, event: named }
  const dot = named.indexOf('.')
  return dot > 0 ? { cap: named.slice(0, dot), event: named.slice(dot + 1) } : null
}

/** Site G: a stored event payload `{ cap, event, payload | data }`. */
function rewriteEventPayload(
  obj: Record<string, unknown>,
  sink: RewriteSink,
): Record<string, unknown> {
  const ref = eventRef(obj)
  if (ref === null) return obj
  const rename = EVENT_PAYLOAD_RENAMES[ref.cap]?.[ref.event]
  if (rename === undefined) return obj
  const slot = isRecord(obj['payload']) ? 'payload' : 'data'
  const payload = obj[slot]
  if (!isRecord(payload)) return obj
  const what = `${ref.cap}.${ref.event} payload`
  if (rename.at === undefined) {
    const next = renameContextKeys(what, rename.renames, payload, sink)
    return next === payload ? obj : { ...obj, [slot]: next }
  }
  const inner = payload[rename.at]
  if (!isRecord(inner)) return obj
  const next = renameContextKeys(what, rename.renames, inner, sink)
  return next === inner ? obj : { ...obj, [slot]: { ...payload, [rename.at]: next } }
}

function siteApplies(site: ProviderConfigSite, obj: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(site.requires).every(([key, want]) =>
    want === true ? typeof obj[key] === 'string' : obj[key] === want,
  )
}

/** Site H: a provider config keyed by a cap's field names. */
function rewriteProviderConfig(
  obj: Record<string, unknown>,
  sink: RewriteSink,
): Record<string, unknown> {
  let out = obj
  for (const site of PROVIDER_CONFIG_SITES) {
    const keyed = out[site.key]
    if (!isRecord(keyed) || !siteApplies(site, out)) continue
    const next = renameFieldKeys(site.cap, keyed, sink)
    if (next !== keyed) out = { ...out, [site.key]: next }
  }
  return out
}

/** Site I: a bare `<cap>.<field>` text. Counted when it names a tracked field. */
function rewriteQualifiedText(text: string, sink: RewriteSink): string {
  const parts = parseQualifiedText(text)
  if (parts === null) return text
  noteField(sink, parts.cap, splitFieldPath(parts.path).field)
  return renamedQualifiedText(text) ?? text
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
  const targetId = obj['targetId']
  if (typeof cap === 'string' && typeof targetId === 'string') {
    const next = rewriteFieldPath(cap, targetId, sink)
    if (next !== targetId) out = { ...out, targetId: next }
  }
  return rewriteProviderConfig(rewriteEventPayload(rewriteCallArgs(out, sink), sink), sink)
}

/** The key of a stored object entry, renamed when it is a bare `<cap>.<field>` text. */
function rewriteEntryKey(key: string, sink: RewriteSink): string {
  return rewriteQualifiedText(key, sink)
}

/** Walk any stored JSON value; the same value is returned when nothing changes. */
export function walk(value: unknown, sink: RewriteSink): unknown {
  if (Array.isArray(value)) return walkArray(value, sink)
  if (typeof value === 'string') return rewriteQualifiedText(value, sink)
  if (!isRecord(value)) return value
  const sited = rewriteSites(value, sink)
  const kept: [string, unknown][] = []
  const renamed: [string, unknown][] = []
  let changed = sited !== value
  for (const [key, child] of Object.entries(sited)) {
    const isCode = key === 'code' && typeof child === 'string'
    if (isCode) noteCodeMentions(child, sink)
    const next = isCode ? child : walk(child, sink)
    const nextKey = rewriteEntryKey(key, sink)
    if (next !== child || nextKey !== key) changed = true
    if (nextKey === key) kept.push([key, next])
    else renamed.push([nextKey, next])
  }
  if (!changed) return value
  const out: Record<string, unknown> = Object.fromEntries(kept)
  for (const [key, child] of renamed) {
    if (Object.hasOwn(out, key)) {
      const parts = parseQualifiedText(key)
      if (parts !== null) bump(sink.merged, refKey(parts.cap, splitFieldPath(parts.path).field))
      continue
    }
    out[key] = child
  }
  return out
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
