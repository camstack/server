/**
 * Writes cap-vocabulary data back as TypeScript source (D1050): enum values as
 * their enum members (`EventCategory.DoorbellRing`, `[DeviceType.Siren]`), so
 * the generated map type-checks against the enums, not against bare strings.
 */
import { DeviceRole, DeviceType } from '../../packages/types/src/device/device-type.ts'
import { EventCategory } from '../../packages/types/src/enums/event-category.ts'

function reverse(e: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  return new Map(Object.entries(e).map(([key, value]) => [value, key]))
}

const CATEGORY_KEYS = reverse(EventCategory)
const DEVICE_TYPE_KEYS = reverse(DeviceType)
const DEVICE_ROLE_KEYS = reverse(DeviceRole)

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A single-quoted TS string literal. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

function propertyKey(key: string, parent: string | undefined): string {
  if (parent === 'byType') {
    const member = DEVICE_TYPE_KEYS.get(key)
    if (member !== undefined) return `[DeviceType.${member}]`
  }
  if (parent === 'byRole') {
    const member = DEVICE_ROLE_KEYS.get(key)
    if (member !== undefined) return `[DeviceRole.${member}]`
  }
  return IDENT.test(key) ? key : quote(key)
}

function isL10n(value: object): value is { readonly en: string; readonly it: string } {
  const keys = Object.keys(value)
  return (
    keys.length === 2 &&
    keys.includes('en') &&
    keys.includes('it') &&
    typeof Reflect.get(value, 'en') === 'string' &&
    typeof Reflect.get(value, 'it') === 'string'
  )
}

/** How a `{ en, it }` pair is written: a plain object, or a `t(en, it)` call. */
export type L10nStyle = 'object' | 't'

/** Serialises one value on one line; `parent` is the key it sits under. */
export function vocabLiteral(value: unknown, l10n: L10nStyle, parent?: string): string {
  if (Array.isArray(value)) return `[${value.map((v) => vocabLiteral(v, l10n)).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    if (l10n === 't' && isL10n(value)) return `t(${quote(value.en)}, ${quote(value.it)})`
    const inner = Object.entries(value).map(
      ([k, v]) => `${propertyKey(k, parent)}: ${vocabLiteral(v, l10n, k)}`,
    )
    return `{ ${inner.join(', ')} }`
  }
  if (typeof value === 'string') {
    if (parent === 'category') {
      const member = CATEGORY_KEYS.get(value)
      if (member !== undefined) return `EventCategory.${member}`
    }
    return quote(value)
  }
  return String(value)
}

const WIDTH = 100

/**
 * Serialises one value over as many lines as it needs: anything that fits in
 * {@link WIDTH} columns from `column` stays on one line, the rest breaks one
 * member per line — a reviewable diff for generated output.
 */
export function vocabLiteralBlock(
  value: unknown,
  l10n: L10nStyle,
  indent: number,
  parent?: string,
  column: number = indent,
): string {
  const flat = vocabLiteral(value, l10n, parent)
  if (column + flat.length <= WIDTH || value === null || typeof value !== 'object') return flat
  if (l10n === 't' && !Array.isArray(value) && isL10n(value)) return flat
  const pad = ' '.repeat(indent + 2)
  const end = ' '.repeat(indent)
  if (Array.isArray(value)) {
    const items = value.map((v) => `${pad}${vocabLiteralBlock(v, l10n, indent + 2)},`)
    return `[\n${items.join('\n')}\n${end}]`
  }
  const items = Object.entries(value).map(([k, v]) => {
    const key = propertyKey(k, parent)
    return `${pad}${key}: ${vocabLiteralBlock(v, l10n, indent + 2, k, indent + 2 + key.length + 2)},`
  })
  return `{\n${items.join('\n')}\n${end}}`
}
