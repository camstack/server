/**
 * Binding + facts → the text a slot should carry. Pure: every input is
 * supplied, including the instant, so a test can pin the clock.
 *
 * The outcome is never just a string. A caller has to be able to tell
 * "gated" from "unreadable" from "unchanged" without guessing, because
 * all three look identical on the camera — and a branch that drops work
 * silently is how this repo has lost three hours of media before.
 */
import type { OsdNamedTemplate, OsdRenderResult, OsdSlotBinding } from '@camstack/types'
import { formatClock, formatSlotText, limitText } from './format.js'
import { evaluateGate, type OsdDeviceStateLookup } from './gate.js'
import { renderNamedTemplate } from './named-template-render.js'
import { readStatePath } from './state-leaves.js'
import { convertForDisplay, inferSourceUnit } from './unit-display.js'

export interface OsdFacts {
  readonly atMs: number
  /** `deviceId` → `capName` → the mirrored state slice. */
  readonly stateByDevice: ReadonlyMap<number, Readonly<Record<string, unknown>>>
  /** Latest durable identity/OCR values known for each camera. */
  readonly recognitionByDevice: ReadonlyMap<number, Readonly<{ person?: string; plate?: string }>>
  /** Resolves the gate's `deviceState` condition. */
  readonly deviceState: OsdDeviceStateLookup
  /** Named templates keyed by id — required when a slot source is `template`. */
  readonly templatesById: ReadonlyMap<string, OsdNamedTemplate>
}

export interface ResolvedSourceValue {
  readonly raw: unknown
  /** Value after unit conversion (numeric device-state). */
  readonly displayRaw?: unknown
  /** Pre-formatted text for template sources (parser already evaluated). */
  readonly preformatted?: string
  readonly unit?: string
}

/**
 * Read the source's value. `null` means "unreadable" — a missing device, a
 * cap that has never published a slice, or a path the slice does not have.
 * The three are distinguished by `reason` so the operator learns which.
 */
export function resolveSource(
  binding: OsdSlotBinding,
  cameraDeviceId: number,
  facts: OsdFacts,
): { value: ResolvedSourceValue } | { reason: string } {
  const source = binding.source
  if (source.kind === 'none') return { value: { raw: '' } }
  if (source.kind === 'static') return { value: { raw: source.text } }
  if (source.kind === 'clock') {
    return { value: { raw: formatClock(facts.atMs, source.pattern, source.timezone) } }
  }
  if (source.kind === 'latest-recognition') {
    const value = facts.recognitionByDevice.get(cameraDeviceId)?.[source.recognition]
    return value === undefined
      ? {
          reason: `no recognized ${source.recognition} has been persisted for device ${cameraDeviceId}`,
        }
      : { value: { raw: value } }
  }
  if (source.kind === 'template') {
    const named = facts.templatesById.get(source.templateId)
    if (named === undefined) {
      return { reason: `named template "${source.templateId}" is missing` }
    }
    const rendered = renderNamedTemplate(named, { stateByDevice: facts.stateByDevice })
    if ('reason' in rendered) return rendered
    return { value: { raw: rendered.text, preformatted: rendered.text } }
  }

  const deviceId = source.deviceId ?? cameraDeviceId
  const deviceState = facts.stateByDevice.get(deviceId)
  if (deviceState === undefined) {
    return { reason: `no state mirrored for device ${deviceId}` }
  }
  const slice = deviceState[source.capName]
  if (slice === undefined) {
    return { reason: `device ${deviceId} publishes no "${source.capName}" state` }
  }
  const raw = readStatePath(slice, source.valuePath)
  if (raw === undefined) {
    return { reason: `"${source.capName}.${source.valuePath}" is absent on device ${deviceId}` }
  }

  if (typeof raw === 'number') {
    const sourceUnit = inferSourceUnit(slice, source.valuePath)
    const converted = convertForDisplay(raw, sourceUnit, source.displayUnit)
    return {
      value: {
        raw,
        displayRaw: converted.value,
        ...(converted.unit !== undefined && converted.unit !== '' ? { unit: converted.unit } : {}),
      },
    }
  }

  return { value: { raw } }
}

/**
 * Render one slot. `previousText` is the last text WE wrote; when the
 * render matches it the outcome is `unchanged` and the caller must not
 * write — a slot rewritten every tick is one firmware round-trip per tick
 * per slot, for a string that did not move.
 */
export function renderSlot(
  slotId: string,
  binding: OsdSlotBinding | null,
  cameraDeviceId: number,
  facts: OsdFacts,
  previousText: string | undefined,
  /** Firmware ceiling from `osd` status for this overlay — never from the binding. */
  maxCharacters?: number,
): OsdRenderResult {
  if (binding === null) {
    return { slotId, outcome: 'unbound', text: '', reason: 'no binding for this slot' }
  }
  if (!binding.enabled) {
    return { slotId, outcome: 'disabled', text: '', reason: 'binding is switched off' }
  }

  const gate = evaluateGate({
    cameraDeviceId,
    atMs: facts.atMs,
    schedule: binding.schedule,
    conditions: binding.conditions,
    deviceState: facts.deviceState,
  })
  if (!gate.open) {
    return settle(slotId, '', previousText, 'gated', `condition "${gate.failedCondition}"`)
  }

  const resolved = resolveSource(binding, cameraDeviceId, facts)
  if ('reason' in resolved) {
    return settle(slotId, '', previousText, 'unreadable', resolved.reason)
  }

  if (resolved.value.preformatted !== undefined && binding.source.kind === 'template') {
    const text = limitText(resolved.value.preformatted.trim(), maxCharacters)
    return settle(slotId, text, previousText, 'written')
  }

  const text = formatSlotText(resolved.value.raw, binding, {
    ...(resolved.value.displayRaw !== undefined ? { displayRaw: resolved.value.displayRaw } : {}),
    ...(resolved.value.unit !== undefined ? { unit: resolved.value.unit } : {}),
    ...(maxCharacters !== undefined ? { maxCharacters } : {}),
  })
  return settle(slotId, text, previousText, 'written')
}

function settle(
  slotId: string,
  text: string,
  previousText: string | undefined,
  outcome: 'written' | 'gated' | 'unreadable',
  reason?: string,
): OsdRenderResult {
  if (previousText !== undefined && previousText === text) {
    return { slotId, outcome: 'unchanged', text, reason }
  }
  return reason === undefined ? { slotId, outcome, text } : { slotId, outcome, text, reason }
}
