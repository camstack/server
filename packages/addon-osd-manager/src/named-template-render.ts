/**
 * Evaluate a named multi-device template parser against live device state.
 * Parser tokens are `{alias}` / `{alias.value}` / `{alias.unit}` / `{alias.full}`;
 * each binding supplies value + unit once; the token picks the expand mode.
 */
import type { OsdNamedTemplate, OsdTemplateBinding, OsdTemplateTokenKind } from '@camstack/types'
import { truncateDecimals } from './format.js'
import { readStatePath } from './state-leaves.js'
import {
  aliasFullToken,
  aliasToken,
  replaceToken,
  type TemplateTokenKind,
} from './template-tokens.js'
import { convertForDisplay, inferSourceUnit } from './unit-display.js'

export interface NamedTemplateFacts {
  /** `deviceId` → `capName` → mirrored state slice. */
  readonly stateByDevice: ReadonlyMap<number, Readonly<Record<string, unknown>>>
}

export type NamedTemplateRender = { readonly text: string } | { readonly reason: string }

export interface BindingLiveParts {
  readonly value: string
  readonly unit: string
  /** Value + unit with no intervening space. Same as `{alias}` / `{alias.full}`. */
  readonly formatted: string
}

/** Combine value/unit for a token kind. */
export function applyTemplateTokenKind(
  value: string,
  unit: string,
  kind: OsdTemplateTokenKind | TemplateTokenKind,
): string {
  if (kind === 'value') return value
  if (kind === 'unit') return unit
  const v = value.trim()
  const u = unit.trim()
  if (v === '') return u
  if (u === '') return v
  // No intervening space: units like °C / % sit against the value (25°C, 55%).
  return `${v}${u}`
}

/**
 * @deprecated Prefer `applyTemplateTokenKind`. Maps legacy format enum to
 * the same join rules (`value+unit` → `full`).
 */
export function applyTemplateFormat(
  value: string,
  unit: string,
  format: 'value+unit' | 'value' | 'unit',
): string {
  const kind: TemplateTokenKind = format === 'value' ? 'value' : format === 'unit' ? 'unit' : 'full'
  return applyTemplateTokenKind(value, unit, kind)
}

/** Resolve one binding to live value/unit/formatted parts (or a reason). */
export function resolveBindingLive(
  binding: OsdTemplateBinding,
  facts: NamedTemplateFacts,
): BindingLiveParts | { readonly reason: string } {
  const deviceId = binding.pick.deviceId
  const deviceState = facts.stateByDevice.get(deviceId)
  if (deviceState === undefined) {
    return { reason: `no state mirrored for device ${deviceId}` }
  }
  const slice = deviceState[binding.capName]
  if (slice === undefined) {
    return {
      reason: `device ${deviceId} publishes no "${binding.capName}" state`,
    }
  }
  const raw = readStatePath(slice, binding.valuePath)
  if (raw === undefined) {
    return {
      reason: `"${binding.capName}.${binding.valuePath}" is absent on device ${deviceId}`,
    }
  }

  // Same order as format.displayValue: valueMap before decimals/unit defaults.
  // An explicit empty string hides (operator-cleared overlay text).
  const mapped = binding.valueMap?.[String(raw)]
  if (mapped !== undefined) {
    return {
      value: mapped,
      unit: '',
      formatted: applyTemplateTokenKind(mapped, '', 'full'),
    }
  }

  let value: string
  let unit = ''
  if (typeof raw === 'number') {
    const sourceUnit = inferSourceUnit(slice, binding.valuePath)
    const converted = convertForDisplay(raw, sourceUnit, binding.displayUnit)
    value = truncateDecimals(converted.value, binding.maxDecimals)
    unit = converted.unit
  } else if (typeof raw === 'boolean') {
    value = raw ? 'ON' : 'OFF'
  } else if (raw === null) {
    value = ''
  } else {
    value = String(raw)
  }

  return {
    value,
    unit,
    formatted: applyTemplateTokenKind(value, unit, 'full'),
  }
}

/** Substitute every token form for one alias from live parts. Longest first. */
export function expandBindingTokens(parser: string, alias: string, live: BindingLiveParts): string {
  let text = parser
  // Explicit `.full` before bare `{alias}` so we do not leave `.full` orphans.
  text = replaceToken(text, aliasFullToken(alias), live.formatted)
  text = replaceToken(text, aliasToken(alias, 'value'), live.value)
  text = replaceToken(text, aliasToken(alias, 'unit'), live.unit)
  text = replaceToken(text, aliasToken(alias, 'full'), live.formatted)
  return text
}

/** Render one named template's parser from live states. */
export function renderNamedTemplate(
  template: OsdNamedTemplate,
  facts: NamedTemplateFacts,
): NamedTemplateRender {
  let text = template.parser
  if (template.bindings.length === 0) {
    return text.trim() === '' ? { reason: `template "${template.id}" has no bindings` } : { text }
  }

  for (const binding of template.bindings) {
    const live = resolveBindingLive(binding, facts)
    if ('reason' in live) return live
    text = expandBindingTokens(text, binding.alias, live)
  }

  return { text }
}
