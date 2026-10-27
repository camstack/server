/**
 * The subset of Home Assistant value templates that MQTT discovery payloads
 * use to pick a field out of a JSON state topic:
 * `{{ value_json.a.b }}`, `{{ value_json['a'] }}`, `{{ value }}`, optionally
 * followed by `| float`, `| int` or `| round(n)`. Statements (`{% … %}`) and
 * any other expression are NOT evaluated: the render is `null`, so an
 * unsupported template reads as "no value", never as a wrong one.
 */

const EXPRESSION = /\{\{\s*([^}]*?)\s*\}\}/g

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    return undefined
  }
}

/** Split `value_json.a['b'].c` into its path segments, or null when malformed. */
function pathSegments(source: string): string[] | null {
  const segments: string[] = []
  const token = /\.([A-Za-z_][\w-]*)|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]/y
  let index = 0
  while (index < source.length) {
    token.lastIndex = index
    const match = token.exec(source)
    if (match === null) return null
    const segment = match[1] ?? match[2] ?? match[3]
    if (segment === undefined) return null
    segments.push(segment)
    index = token.lastIndex
  }
  return segments
}

function walk(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function stringify(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return JSON.stringify(value)
}

function applyFilter(value: string, filter: string): string | null {
  const name = filter.trim()
  if (name === 'float') {
    const n = Number(value)
    return Number.isFinite(n) ? String(n) : null
  }
  if (name === 'int') {
    const n = Number(value)
    return Number.isFinite(n) ? String(Math.trunc(n)) : null
  }
  const round = /^round\(\s*(\d+)\s*\)$/.exec(name)
  if (round !== null) {
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    return String(Number(n.toFixed(Number(round[1]))))
  }
  return null
}

function evaluate(expression: string, raw: string, json: unknown): string | null {
  const [head, ...filters] = expression.split('|')
  const source = (head ?? '').trim()
  let rendered: string | null
  if (source === 'value') {
    rendered = raw
  } else if (
    source === 'value_json' ||
    source.startsWith('value_json.') ||
    source.startsWith('value_json[')
  ) {
    if (json === undefined) return null
    const segments = pathSegments(source.slice('value_json'.length))
    if (segments === null) return null
    rendered = stringify(walk(json, segments))
  } else {
    return null
  }
  for (const filter of filters) {
    if (rendered === null) return null
    rendered = applyFilter(rendered, filter)
  }
  return rendered
}

/**
 * Render `template` against an MQTT payload. With no template the trimmed
 * payload is the value. `null` means "no value" (field absent, payload not
 * JSON, or an expression this subset does not evaluate).
 */
export function renderTemplate(template: string | null, payload: string): string | null {
  const raw = payload.trim()
  if (template === null) return raw
  if (template.includes('{%')) return null
  const json = parseJson(raw)
  let failed = false
  const out = template.replace(EXPRESSION, (_whole, expression: string) => {
    const value = evaluate(expression, raw, json)
    if (value === null) {
      failed = true
      return ''
    }
    return value
  })
  return failed ? null : out.trim()
}
