/**
 * D692: which rules may carry `groupingSec`. ONE predicate, read by both editors
 * and the hub's save guard. The table is spec §2.2 verbatim.
 */
import { describe, expect, it } from 'vitest'
import { NC_AUDIO_SEED, NC_OCCUPANCY_DEFAULTS, ruleGroupingApplies } from '../rule-kinds.js'

describe('ruleGroupingApplies (D692 §2.2)', () => {
  it.each([
    ['detection immediate', 'immediate', { classes: ['person'] }, true],
    ['detection immediate, recognition-scoped', 'immediate', { identities: [] }, true],
    ['detection track-end', 'track-end', { classes: ['person'] }, false],
    ['package-event', 'package-event', { packagePhase: 'delivered' }, false],
    ['sound (immediate + audio)', 'immediate', { audio: NC_AUDIO_SEED }, false],
    ['sensor', 'device-event', { sensorKinds: ['doorbell'] }, false],
    ['occupancy', 'device-event', { occupancy: NC_OCCUPANCY_DEFAULTS }, false],
    ['system', 'system-event', { systemEvent: { kinds: ['device.offline'] } }, false],
  ] as const)('%s → %s', (_label, delivery, conditions, expected) => {
    expect(ruleGroupingApplies({ delivery, conditions })).toBe(expected)
  })
})
