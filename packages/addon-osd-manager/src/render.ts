/**
 * Binding + rendered templates → the text a slot should carry. Pure: every
 * input is supplied, including the instant, so a test can pin the clock.
 *
 * The outcome is never just a string. A caller has to be able to tell
 * "gated" from "unreadable" from "unchanged" without guessing, because
 * all three look identical on the camera — and a branch that drops work
 * silently is how this repo has lost three hours of media before.
 *
 * `unreadable` carries the LAST good text and is never written: an error
 * string must not reach a camera.
 */
import type { OsdRenderResult, OsdSlotBinding } from '@camstack/types'
import { limitText } from './format.js'
import { evaluateGate, type OsdDeviceStateLookup } from './gate.js'
import type { TemplateOutcome } from './template-context.js'

export interface OsdFacts {
  readonly atMs: number
  /** Resolves the gate's `deviceState` condition. */
  readonly deviceState: OsdDeviceStateLookup
  /** Rendered named templates by id — present for every template a slot uses. */
  readonly rendered: ReadonlyMap<string, TemplateOutcome>
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

  const source = binding.source
  if (source.kind === 'none') return settle(slotId, '', previousText, 'written')
  if (source.kind === 'static') {
    return settle(slotId, limitText(source.text.trim(), maxCharacters), previousText, 'written')
  }

  const outcome = facts.rendered.get(source.templateId)
  if (outcome === undefined) {
    return unreadable(slotId, previousText, `named template "${source.templateId}" is missing`)
  }
  if (!outcome.ok) return unreadable(slotId, previousText, outcome.reason)
  return settle(slotId, limitText(outcome.text.trim(), maxCharacters), previousText, 'written')
}

function unreadable(
  slotId: string,
  previousText: string | undefined,
  reason: string,
): OsdRenderResult {
  return { slotId, outcome: 'unreadable', text: previousText ?? '', reason }
}

function settle(
  slotId: string,
  text: string,
  previousText: string | undefined,
  outcome: 'written' | 'gated',
  reason?: string,
): OsdRenderResult {
  if (previousText !== undefined && previousText === text) {
    return { slotId, outcome: 'unchanged', text, reason }
  }
  return reason === undefined ? { slotId, outcome, text } : { slotId, outcome, text, reason }
}
