/**
 * The subset of Home Assistant value templates that MQTT discovery payloads
 * use to pick a field out of a JSON state topic:
 * `{{ value_json.a.b }}`, `{{ value_json['a'] }}`, `{{ value }}`, optionally
 * followed by `| float`, `| int` or `| round(n)`.
 *
 * Two statement forms are evaluated, because discovery payloads use them as
 * the whole template: `{% if "field" in value_json %}…{% endif %}` (a Velux
 * plug's switch) and `{% if value_json.field > 0 %}…{% else %}…{% endif %}`.
 * Any other `{% … %}` is `null`, so an unsupported template reads as "no
 * value", never as a wrong one.
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

const IF_IN =
  /^\{%\s*if\s+(['"])([^'"]+)\1\s+in\s+value_json\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}$/

const IF_ELSE = /^\{%\s*if\s+(.+?)\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}$/

const COMPARE = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/

function renderExpressions(template: string, raw: string): string | null {
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

function literal(source: string): string | null {
  const text = source.trim()
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text)
  if (quoted !== null) return quoted[2] ?? ''
  if (text === 'true' || text === 'false') return text
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text
  return null
}

function compareCondition(condition: string, raw: string): boolean | null {
  const match = COMPARE.exec(condition.trim())
  if (match === null) return null
  const leftSrc = match[1] ?? ''
  const op = match[2]
  const right = literal(match[3] ?? '')
  if (op === undefined || right === null) return null
  const left = evaluate(leftSrc, raw, parseJson(raw))
  if (left === null) return null
  if (op === '==') return left === right
  if (op === '!=') return left !== right
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return null
  if (op === '>') return leftNumber > rightNumber
  if (op === '>=') return leftNumber >= rightNumber
  if (op === '<') return leftNumber < rightNumber
  return leftNumber <= rightNumber
}

/** `{% if "state" in value_json %}…{% endif %}`, else optional. */
function renderMembership(template: string, raw: string): string | null | undefined {
  const match = IF_IN.exec(template)
  if (match === null) return undefined
  const key = match[2]
  const thenBranch = match[3] ?? ''
  const elseBranch = match[4]
  if (key === undefined) return null
  const json = parseJson(raw)
  const present = isRecord(json) && Object.hasOwn(json, key)
  if (!present) return elseBranch === undefined ? null : renderExpressions(elseBranch, raw)
  return renderExpressions(thenBranch, raw)
}

/** `{% if value_json.field > 0 %}…{% else %}…{% endif %}`. */
function renderComparison(template: string, raw: string): string | null | undefined {
  const match = IF_ELSE.exec(template)
  if (match === null) return undefined
  const passed = compareCondition(match[1] ?? '', raw)
  if (passed === null) return null
  return renderExpressions(passed ? (match[2] ?? '') : (match[3] ?? ''), raw)
}

function renderStatement(template: string, raw: string): string | null | undefined {
  const trimmed = template.trim()
  const membership = renderMembership(trimmed, raw)
  if (membership !== undefined) return membership
  return renderComparison(trimmed, raw)
}

/**
 * Render `template` against an MQTT payload. With no template the trimmed
 * payload is the value. `null` means "no value" (field absent, payload not
 * JSON, or an expression this subset does not evaluate).
 */
export function renderTemplate(template: string | null, payload: string): string | null {
  const raw = payload.trim()
  if (template === null) return raw
  const statement = renderStatement(template, raw)
  if (statement !== undefined) return statement
  if (template.includes('{%')) return null
  return renderExpressions(template, raw)
}
