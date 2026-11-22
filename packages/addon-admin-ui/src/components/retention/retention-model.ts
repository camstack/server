/**
 * Data → Retention is derived from the `retention-source` catalog (D1084): the page
 * hardcodes no knob. This is the pure part — grouping the knobs of every owner, judging a
 * typed value against the knob's own bounds, and building the settings call that
 * writes it back.
 */
import type { RetentionKnob } from '@camstack/types'

export interface RetentionGroup {
  readonly group: string
  readonly knobs: readonly RetentionKnob[]
}

/** The knobs of every owner, grouped by `group` in first-seen order; a knob lists once. */
export function groupKnobs(knobs: readonly RetentionKnob[]): readonly RetentionGroup[] {
  const order: string[] = []
  const byGroup = new Map<string, RetentionKnob[]>()
  const seen = new Set<string>()
  for (const knob of knobs) {
    if (seen.has(knob.id)) continue
    seen.add(knob.id)
    const list = byGroup.get(knob.group)
    if (list === undefined) {
      order.push(knob.group)
      byGroup.set(knob.group, [knob])
    } else list.push(knob)
  }
  return order.map((group) => ({ group, knobs: byGroup.get(group) ?? [] }))
}

export type KnobVerdict =
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false
      readonly reason: 'not-a-number' | 'not-whole' | 'below-min' | 'above-max'
    }

/** A typed value against the knob's bounds; `0` is only valid where it means keep forever. */
export function judgeKnobValue(knob: RetentionKnob, text: string): KnobVerdict {
  const trimmed = text.trim()
  const value = Number(trimmed)
  if (trimmed === '' || !Number.isFinite(value)) return { ok: false, reason: 'not-a-number' }
  if (!Number.isInteger(value)) return { ok: false, reason: 'not-whole' }
  if (value === 0 && knob.zeroMeansForever) return { ok: true, value }
  if (knob.min !== undefined && value < knob.min) return { ok: false, reason: 'below-min' }
  if (knob.max !== undefined && value > knob.max) return { ok: false, reason: 'above-max' }
  return { ok: true, value }
}

export type KnobWriteCall =
  | {
      readonly method: 'updateScopedSettings'
      readonly input: {
        readonly addonId: string
        readonly cap: string
        readonly scope: 'cluster' | 'node'
        readonly patch: Readonly<Record<string, number>>
      }
    }
  | {
      readonly method: 'updateDeviceSettings'
      readonly input: {
        readonly addonId: string
        readonly deviceId: number
        readonly patch: Readonly<Record<string, number>>
      }
    }

/** The existing settings call that owns the knob, with the value as its patch. `null`: a device write without a device. */
export function writeCallFor(knob: RetentionKnob, value: number): KnobWriteCall | null {
  const patch = { [knob.key]: value }
  if (knob.write.method === 'updateScopedSettings') {
    return {
      method: 'updateScopedSettings',
      input: {
        addonId: knob.write.addonId,
        cap: knob.write.cap,
        scope: knob.write.scope,
        patch,
      },
    }
  }
  if (knob.deviceId === undefined) return null
  return {
    method: 'updateDeviceSettings',
    input: { addonId: knob.write.addonId, deviceId: knob.deviceId, patch },
  }
}
