/**
 * The API explorer's pure half (planning#595): the input skeleton drawn from a
 * method's JSON Schema, the check an input passes before it is sent, the curl
 * line for the same call, and the typed error a call answered with.
 *
 * The schema comes from `apiCatalog.inputSchema` (the method's own Zod parser,
 * as JSON Schema with `io: 'input'`), so a defaulted field is optional here.
 */

export type JsonSchema = Readonly<Record<string, unknown>>

/** Explorer address of one method: `/system/settings?tab=api-explorer&method=<path>`. */
export const API_EXPLORER_METHOD_PARAM = 'method'

const MAX_DEPTH = 8

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function schemaList(value: unknown): readonly JsonSchema[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** `#/$defs/X` (or `#/definitions/X`) against the root document; anything else stays as is. */
export function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema['$ref']
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return schema
  let node: unknown = root
  for (const part of ref.slice(2).split('/')) {
    node = isRecord(node) ? node[part] : undefined
  }
  return isRecord(node) ? node : schema
}

export function typesOf(schema: JsonSchema): readonly string[] {
  const type = schema['type']
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string')
  return []
}

export function requiredOf(schema: JsonSchema): readonly string[] {
  const required = schema['required']
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : []
}

function skeletonAt(raw: JsonSchema, root: JsonSchema, depth: number): unknown {
  const schema = resolveRef(raw, root)
  if (depth > MAX_DEPTH) return null
  if ('default' in schema) return schema['default']
  if ('const' in schema) return schema['const']
  const enumValues = schema['enum']
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0]
  const union = [...schemaList(schema['anyOf']), ...schemaList(schema['oneOf'])]
  if (union.length > 0) {
    const pick = union.find((s) => !typesOf(resolveRef(s, root)).includes('null')) ?? union[0]
    return pick === undefined ? null : skeletonAt(pick, root, depth + 1)
  }
  const all = schemaList(schema['allOf'])
  if (all.length > 0) {
    return all.reduce<unknown>((acc, part) => {
      const next = skeletonAt(part, root, depth + 1)
      return isRecord(acc) && isRecord(next) ? { ...acc, ...next } : next
    }, {})
  }
  const type = typesOf(schema).find((t) => t !== 'null')
  switch (type) {
    case 'object':
      return objectSkeleton(schema, root, depth)
    case 'array':
      return arraySkeleton(schema, root, depth)
    case 'string':
      return stringSkeleton(schema)
    case 'number':
    case 'integer':
      return numberSkeleton(schema, type === 'integer')
    case 'boolean':
      return false
    default:
      return isRecord(schema['properties']) ? objectSkeleton(schema, root, depth) : null
  }
}

/** One example per JSON Schema string `format`, valid for the parser that named it. */
const FORMAT_EXAMPLES: Readonly<Record<string, string>> = {
  uri: 'https://example.com',
  url: 'https://example.com',
  email: 'user@example.com',
  uuid: '00000000-0000-4000-8000-000000000000',
  'date-time': '2026-01-01T00:00:00.000Z',
  date: '2026-01-01',
  time: '00:00:00',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  hostname: 'example.com',
}

/** Tried, in order, when a string carries a `pattern` and no `format` example fits. */
const PATTERN_CANDIDATES: readonly string[] = [
  'example',
  'a',
  'a0',
  'a-b',
  'a1-b2',
  'example-1',
  'a.b',
  'a_b',
  'a:b',
  'abc:abc',
  'a-b:c-d',
  'example.com',
  'mqtt://example.com',
  'abcdef0',
  '0'.repeat(64),
  'A',
  '0',
  '1',
  '0.0',
]

function patternFits(pattern: unknown, value: string): boolean {
  if (typeof pattern !== 'string') return true
  try {
    return new RegExp(pattern, 'u').test(value)
  } catch {
    return true
  }
}

function lengthFits(schema: JsonSchema, value: string): boolean {
  const min = schema['minLength']
  const max = schema['maxLength']
  return (
    (typeof min !== 'number' || value.length >= min) &&
    (typeof max !== 'number' || value.length <= max)
  )
}

/**
 * A string the schema accepts: a format example, a pattern-matching candidate,
 * or `x` repeated to the minimum length. A pattern no candidate fits (a regex
 * nobody can invert in general) falls back to the empty string, and the audit
 * names it.
 */
function stringSkeleton(schema: JsonSchema): string {
  const format = schema['format']
  const example = typeof format === 'string' ? FORMAT_EXAMPLES[format] : undefined
  const min = typeof schema['minLength'] === 'number' ? schema['minLength'] : 0
  // Without a pattern or a format only the length can matter.
  const constrained = typeof schema['pattern'] === 'string' || example !== undefined
  const candidates = !constrained
    ? []
    : example === undefined
      ? PATTERN_CANDIDATES
      : [example, ...PATTERN_CANDIDATES]
  const padded = [...candidates, 'x'.repeat(min)]
  const hit = padded.find((c) => patternFits(schema['pattern'], c) && lengthFits(schema, c))
  if (hit !== undefined) return hit
  return typeof schema['pattern'] === 'string' ? '' : 'x'.repeat(min)
}

function numberSkeleton(schema: JsonSchema, integer: boolean): number {
  const min = schema['minimum']
  const exclusiveMin = schema['exclusiveMinimum']
  const max = schema['maximum']
  if (typeof min === 'number') return min
  if (typeof exclusiveMin === 'number')
    return integer ? Math.floor(exclusiveMin) + 1 : exclusiveMin + 1
  if (typeof max === 'number' && max < 0) return max
  return 0
}

/** `minItems` elements of the item skeleton, so a required list is not refused as empty. */
function arraySkeleton(schema: JsonSchema, root: JsonSchema, depth: number): readonly unknown[] {
  const min = schema['minItems']
  const items = schema['items']
  if (typeof min !== 'number' || min <= 0 || !isRecord(items)) return []
  return Array.from({ length: min }, () => skeletonAt(items, root, depth + 1))
}

function objectSkeleton(schema: JsonSchema, root: JsonSchema, depth: number): unknown {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {}
  const out: Record<string, unknown> = {}
  for (const key of requiredOf(schema)) {
    const prop = properties[key]
    out[key] = isRecord(prop) ? skeletonAt(prop, root, depth + 1) : null
  }
  return out
}

/**
 * The input an operator starts from: every REQUIRED field filled with its
 * default, its first allowed value, its minimum or an empty value of its type. Optional
 * fields are left out — the schema beside the editor names them.
 */
export function skeletonFromSchema(schema: JsonSchema | null): unknown {
  if (schema === null) return undefined
  // A void / undefined / unknown input has no keys to draw: nothing to send.
  if (Object.keys(schema).every((k) => k === '$schema' || k === '$defs')) return undefined
  return skeletonAt(schema, schema, 0)
}

export type InputIssueCode =
  | 'type'
  | 'required'
  | 'enum'
  | 'const'
  | 'unknown-field'
  | 'no-branch'
  | 'minimum'
  | 'maximum'
  | 'min-length'
  | 'max-length'

/** One reason an input would be refused; `path` is a JSON pointer-ish `a.b.0`, `''` for the root. */
export interface InputIssue {
  readonly path: string
  readonly code: InputIssueCode
  /** What the schema wanted (a type name, a bound, a field) — shown as is. */
  readonly expected: string
}

function typeOfValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = typeOfValue(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

function join(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${key}`
}

function checkAt(
  value: unknown,
  raw: JsonSchema,
  root: JsonSchema,
  path: string,
  depth: number,
): readonly InputIssue[] {
  const schema = resolveRef(raw, root)
  if (depth > MAX_DEPTH * 2) return []
  const union = [...schemaList(schema['anyOf']), ...schemaList(schema['oneOf'])]
  if (union.length > 0) {
    const fits = union.some((branch) => checkAt(value, branch, root, path, depth + 1).length === 0)
    if (!fits) return [{ path, code: 'no-branch', expected: `${union.length}` }]
  }
  const issues: InputIssue[] = []
  for (const part of schemaList(schema['allOf'])) {
    issues.push(...checkAt(value, part, root, path, depth + 1))
  }
  const types = typesOf(schema)
  if (types.length > 0 && !types.some((t) => typeMatches(value, t))) {
    return [...issues, { path, code: 'type', expected: types.join(' | ') }]
  }
  if ('const' in schema && JSON.stringify(schema['const']) !== JSON.stringify(value)) {
    issues.push({ path, code: 'const', expected: JSON.stringify(schema['const']) })
  }
  const enumValues = schema['enum']
  if (Array.isArray(enumValues)) {
    const allowed = enumValues.map((v) => JSON.stringify(v))
    if (!allowed.includes(JSON.stringify(value))) {
      issues.push({ path, code: 'enum', expected: allowed.join(', ') })
    }
  }
  if (typeof value === 'number') issues.push(...numberIssues(value, schema, path))
  if (typeof value === 'string') issues.push(...stringIssues(value, schema, path))
  if (Array.isArray(value) && isRecord(schema['items'])) {
    const items = schema['items']
    value.forEach((item, i) => issues.push(...checkAt(item, items, root, join(path, i), depth + 1)))
  }
  if (isRecord(value)) issues.push(...objectIssues(value, schema, root, path, depth))
  return issues
}

function numberIssues(value: number, schema: JsonSchema, path: string): readonly InputIssue[] {
  const issues: InputIssue[] = []
  const min = schema['minimum']
  const max = schema['maximum']
  if (typeof min === 'number' && value < min)
    issues.push({ path, code: 'minimum', expected: `${min}` })
  if (typeof max === 'number' && value > max)
    issues.push({ path, code: 'maximum', expected: `${max}` })
  return issues
}

function stringIssues(value: string, schema: JsonSchema, path: string): readonly InputIssue[] {
  const issues: InputIssue[] = []
  const min = schema['minLength']
  const max = schema['maxLength']
  if (typeof min === 'number' && value.length < min) {
    issues.push({ path, code: 'min-length', expected: `${min}` })
  }
  if (typeof max === 'number' && value.length > max) {
    issues.push({ path, code: 'max-length', expected: `${max}` })
  }
  return issues
}

function objectIssues(
  value: Readonly<Record<string, unknown>>,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  depth: number,
): readonly InputIssue[] {
  const issues: InputIssue[] = []
  const properties = isRecord(schema['properties']) ? schema['properties'] : {}
  for (const key of requiredOf(schema)) {
    if (!(key in value)) issues.push({ path: join(path, key), code: 'required', expected: key })
  }
  for (const [key, child] of Object.entries(value)) {
    const prop = properties[key]
    if (isRecord(prop)) {
      issues.push(...checkAt(child, prop, root, join(path, key), depth + 1))
    } else if (schema['additionalProperties'] === false) {
      issues.push({ path: join(path, key), code: 'unknown-field', expected: key })
    }
  }
  return issues
}

/** Every reason the hub would refuse `value` for this schema, before it is sent. */
export function checkInputAgainstSchema(
  value: unknown,
  schema: JsonSchema | null,
): readonly InputIssue[] {
  if (schema === null) return []
  return checkAt(value, schema, schema, '', 0)
}

export type ParsedInput =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

/** The editor's text as a value; blank means "no input". */
export function parseInputText(text: string): ParsedInput {
  if (text.trim() === '') return { ok: true, value: undefined }
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export type ApiCallKind = 'query' | 'mutation'

export interface CurlRequest {
  /** The hub's absolute base, no trailing slash (`hubOrigin()`). */
  readonly hubBase: string
  readonly path: string
  readonly kind: ApiCallKind
  readonly input: unknown
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The same call as a curl line, in the wire format the hub speaks: the input
 * in superjson's `{"json": …}` envelope, a query as GET `?input=`, a mutation
 * as a POST body. The token is the `$DOMINEVO_API_TOKEN` placeholder, never the
 * session's.
 */
export function buildCurl(request: CurlRequest): string {
  const url = `${request.hubBase}/trpc/${request.path}`
  const auth = `-H "Authorization: Bearer $DOMINEVO_API_TOKEN"`
  const envelope = request.input === undefined ? null : JSON.stringify({ json: request.input })
  if (request.kind === 'mutation') {
    const body = envelope ?? JSON.stringify({ json: null })
    return [
      `curl -sS -X POST ${auth} \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  --data ${shellQuote(body)} \\`,
      `  ${shellQuote(url)}`,
    ].join('\n')
  }
  const query = envelope === null ? '' : `?input=${encodeURIComponent(envelope)}`
  // i18n-ignore: a shell command, not display text
  return `curl -sS ${auth} \\\n  ${shellQuote(`${url}${query}`)}`
}

/** What a failed call answered, read off the tRPC client error. */
export interface ApiCallError {
  readonly message: string
  readonly code: string | null
  readonly httpStatus: number | null
  readonly path: string | null
  readonly capRouteReason: string | null
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

export function apiCallErrorOf(err: unknown): ApiCallError {
  const message = err instanceof Error ? err.message : String(err)
  const data: unknown = isRecord(err) || err instanceof Error ? Reflect.get(err, 'data') : undefined
  if (!isRecord(data)) {
    return { message, code: null, httpStatus: null, path: null, capRouteReason: null }
  }
  const status = data['httpStatus']
  return {
    message,
    code: stringField(data, 'code'),
    httpStatus: typeof status === 'number' ? status : null,
    path: stringField(data, 'path'),
    capRouteReason: stringField(data, 'capRouteReason'),
  }
}

/** A result as the explorer prints it: pretty JSON, `undefined` as the word. */
export function formatResult(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
