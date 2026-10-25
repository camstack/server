/**
 * Named-template token helpers.
 *
 * Grammar (one binding stem `alias`):
 * - `{alias}` or `{alias.full}` → value + unit (after displayUnit convert)
 * - `{alias.value}` → formatted value only
 * - `{alias.unit}` → unit string only
 */
import type { OsdTemplateBinding, OsdTemplateTokenKind } from '@camstack/types'

export type TemplateTokenKind = OsdTemplateTokenKind

/** Build a placeholder token for one binding alias + expand kind. */
export function aliasToken(alias: string, kind: TemplateTokenKind = 'full'): string {
  if (kind === 'full') return `{${alias}}`
  return `{${alias}.${kind}}`
}

/** Explicit `{alias.full}` form (chips prefer this over bare `{alias}`). */
export function aliasFullToken(alias: string): string {
  return `{${alias}.full}`
}

/** Chip / parser insert options for one binding (value, unit, value+unit). */
export function bindingInsertChips(binding: Pick<OsdTemplateBinding, 'alias'>): readonly {
  readonly id: string
  readonly label: string
  readonly token: string
  readonly kind: TemplateTokenKind
}[] {
  const alias = binding.alias
  return [
    {
      id: `${alias}.value`,
      label: `${alias} · value`,
      token: aliasToken(alias, 'value'),
      kind: 'value',
    },
    {
      id: `${alias}.unit`,
      label: `${alias} · unit`,
      token: aliasToken(alias, 'unit'),
      kind: 'unit',
    },
    {
      id: `${alias}.full`,
      label: `${alias} · value+unit`,
      token: aliasFullToken(alias),
      kind: 'full',
    },
  ]
}

/** @deprecated Prefer `bindingInsertChips` — bare `{alias}` only. */
export function bindingToken(binding: Pick<OsdTemplateBinding, 'alias'>): string {
  return aliasToken(binding.alias, 'full')
}

export interface ParsedAliasToken {
  readonly alias: string
  readonly kind: TemplateTokenKind
  /** Exact matched token text including braces. */
  readonly token: string
}

/**
 * Parse `{alias}`, `{alias.value}`, `{alias.unit}`, `{alias.full}` from a
 * parser string. Bare `{alias}` and `{alias.full}` both mean `full`.
 */
export function parseAliasTokens(parser: string): readonly ParsedAliasToken[] {
  const out: ParsedAliasToken[] = []
  const seen = new Set<string>()
  const re = /\{([A-Za-z][A-Za-z0-9_-]*)(?:\.(value|unit|full))?\}/g
  for (const match of parser.matchAll(re)) {
    const alias = match[1]
    if (alias === undefined || alias === '') continue
    const suffix = match[2]
    const kind: TemplateTokenKind = suffix === 'value' || suffix === 'unit' ? suffix : 'full'
    const token = match[0] ?? ''
    const key = `${alias}:${kind}:${token}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ alias, kind, token })
  }
  return out
}

/** Unique alias stems referenced by a parser (any token kind). */
export function parseAliasStems(parser: string): readonly string[] {
  const stems: string[] = []
  for (const entry of parseAliasTokens(parser)) {
    if (!stems.includes(entry.alias)) stems.push(entry.alias)
  }
  return stems
}

/** Replace every occurrence of `token` in `parser` with `value`. */
export function replaceToken(parser: string, token: string, value: string): string {
  return parser.replaceAll(token, value)
}

/**
 * Suggest a short unique alias from a device/field name.
 * Falls back to `b1`, `b2`, … when the slug collides.
 */
export function suggestAlias(
  seed: string,
  taken: ReadonlySet<string>,
  fallbackPrefix = 'b',
): string {
  const slug = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'a$1')
    .slice(0, 24)
  const base = slug.length > 0 ? slug : fallbackPrefix
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}${i}`.slice(0, 32)
    if (!taken.has(candidate)) return candidate
  }
  return `${fallbackPrefix}${Date.now().toString(36)}`
}
