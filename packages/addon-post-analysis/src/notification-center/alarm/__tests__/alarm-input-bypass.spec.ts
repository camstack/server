/**
 * "Bypass this input until disarm", on the REAL panel.
 *
 * An input is ONE (rule, device) pair. The bypass must silence exactly that
 * pair, leave every other input armed, survive a restart and a self re-arm,
 * and end with the arm session (a disarm of any kind, or a new arm).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NcRuleFireRef } from '../../rule-engine.js'
import { NcAlarmPanelDevice } from '../alarm-panel-device.js'
import { makePanelContext, type NcTestLogLine } from './panel-test-context.js'

const RULE_A = 'rule-perimeter'
const RULE_B = 'rule-garden'
const CAMERA = 102
const PIR = 3301
const DOOR = 3302

interface Harness {
  readonly device: NcAlarmPanelDevice
  readonly config: Record<string, unknown>
  readonly logs: NcTestLogLine[]
  restart(): Harness
}

function buildPanel(persisted: Record<string, unknown> = {}): Harness {
  const config: Record<string, unknown> = { ...persisted }
  const logs: NcTestLogLine[] = []
  const { ctx } = makePanelContext(config, logs)
  const device = new NcAlarmPanelDevice(ctx)
  return { device, config, logs, restart: () => buildPanel(config) }
}

function ref(ruleId: string, sourceDeviceId: number | undefined): NcRuleFireRef {
  return {
    ruleId,
    ruleName: ruleId === RULE_A ? 'Perimeter' : 'Garden',
    deviceId: CAMERA,
    ...(sourceDeviceId !== undefined ? { sourceDeviceId } : {}),
    recordId: `row-${ruleId}-${String(sourceDeviceId)}`,
    timestamp: Date.now(),
  }
}

function bypassOf(
  ruleId: string,
  deviceId: number,
): {
  ruleId: string
  ruleName: string
  deviceId: number
  cameraId: number
} {
  return { ruleId, ruleName: 'Perimeter', deviceId, cameraId: CAMERA }
}

describe('bypassing one alarm input until disarm', () => {
  let h: Harness
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T02:00:00Z'))
    h = buildPanel({ exitDelaySec: 0, entryDelaySec: 0, triggeredDurationSec: 0 })
    await h.device.armWith('away')
  })
  afterEach(() => {
    h.device.stopCountdown()
    vi.useRealTimers()
  })

  it('drops ONLY that (rule, input) pair — the panel stays armed', () => {
    const outcome = h.device.bypassInput(bypassOf(RULE_A, PIR))
    expect(outcome.outcome).toBe('bypassed')
    expect(h.device.triggerFromRule(ref(RULE_A, PIR))).toBe('ignored-bypassed')
    expect(h.device.currentState()).toBe('armed_away')
    const line = h.logs.find((l) => l.message.includes('input is bypassed until disarm'))
    expect(line?.deviceId).toBe(PIR)
    expect(line?.meta?.['dropped']).toBe(1)
  })

  it('another device of the SAME rule still triggers', () => {
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    expect(h.device.triggerFromRule(ref(RULE_A, DOOR))).toBe('accepted')
    expect(h.device.currentState()).toBe('triggered')
  })

  it('the same device under ANOTHER rule still triggers', () => {
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    expect(h.device.triggerFromRule(ref(RULE_B, PIR))).toBe('accepted')
    expect(h.device.currentState()).toBe('triggered')
  })

  it('a camera input (no sensor) is keyed by the camera', () => {
    h.device.bypassInput(bypassOf(RULE_A, CAMERA))
    expect(h.device.triggerFromRule(ref(RULE_A, undefined))).toBe('ignored-bypassed')
  })

  it('classifies a bypassed match as `bypassed`, so the rule push is suppressed too', () => {
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    expect(h.device.classifyRuleMatch(ref(RULE_A, PIR))).toEqual({
      kind: 'bypassed',
      ruleId: RULE_A,
      sensorDeviceId: PIR,
    })
    expect(h.device.classifyRuleMatch(ref(RULE_A, DOOR)).kind).not.toBe('bypassed')
  })

  it('a DISARM clears every bypass — the next arm watches the input again', async () => {
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    await h.device.disarm()
    expect(h.device.inputBypasses()).toEqual([])
    await h.device.armWith('away')
    expect(h.device.triggerFromRule(ref(RULE_A, PIR))).toBe('accepted')
  })

  it('a NEW arm (without a disarm) starts a new session and clears the bypasses', async () => {
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    await h.device.armWith('home')
    expect(h.device.inputBypasses()).toEqual([])
  })

  it('survives a restart, dropped count included', () => {
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    h.device.triggerFromRule(ref(RULE_A, PIR))
    h.device.stopCountdown()
    const after = h.restart()
    expect(after.device.triggerFromRule(ref(RULE_A, PIR))).toBe('ignored-bypassed')
    expect(after.device.inputBypasses()).toEqual([
      expect.objectContaining({ ruleId: RULE_A, deviceId: PIR, dropped: 2 }),
    ])
    after.device.stopCountdown()
  })

  it('is REFUSED on a disarmed panel', async () => {
    await h.device.disarm()
    expect(h.device.bypassInput(bypassOf(RULE_A, PIR))).toEqual({
      outcome: 'refused',
      reason: 'disarmed',
    })
  })

  it('is STALE when the notification predates the current arm session', async () => {
    const before = Date.now()
    vi.advanceTimersByTime(60_000)
    await h.device.disarm()
    await h.device.armWith('away')
    expect(h.device.bypassInput({ ...bypassOf(RULE_A, PIR), notedAt: before })).toEqual({
      outcome: 'refused',
      reason: 'stale',
    })
  })

  it('twice is idempotent, and several inputs can be bypassed', () => {
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    expect(h.device.bypassInput(bypassOf(RULE_A, PIR)).outcome).toBe('already-bypassed')
    h.device.bypassInput(bypassOf(RULE_B, DOOR))
    expect(h.device.inputBypasses().map((b) => b.deviceId)).toEqual([PIR, DOOR])
  })

  it('does NOT cancel a trigger in progress — it only stops further re-triggers', () => {
    expect(h.device.triggerFromRule(ref(RULE_A, PIR))).toBe('accepted')
    expect(h.device.bypassInput(bypassOf(RULE_A, PIR)).outcome).toBe('bypassed')
    expect(h.device.currentState()).toBe('triggered')
  })

  it('a pruned rule takes its bypass with it', () => {
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    h.device.bypassInput(bypassOf(RULE_B, DOOR))
    h.device.pruneInputBypasses((b) => b.ruleId !== RULE_A)
    expect(h.device.inputBypasses().map((b) => b.ruleId)).toEqual([RULE_B])
    expect(h.device.triggerFromRule(ref(RULE_A, PIR))).toBe('accepted')
  })
})

describe('the bypass and the siren window', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('survives the self RE-ARM after a bounded siren — same session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T02:00:00Z'))
    const h = buildPanel({
      exitDelaySec: 0,
      entryDelaySec: 0,
      triggeredDurationSec: 30,
      postTriggeredAction: 'rearmAfter',
    })
    await h.device.armWith('away')
    h.device.triggerFromRule(ref(RULE_A, PIR))
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    vi.advanceTimersByTime(31_000)
    expect(h.device.currentState()).toBe('armed_away')
    expect(h.device.triggerFromRule(ref(RULE_A, PIR))).toBe('ignored-bypassed')
    h.device.stopCountdown()
  })

  it('an AUTO-disarm after the siren (disableAfter) clears the bypasses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T02:00:00Z'))
    const h = buildPanel({
      exitDelaySec: 0,
      entryDelaySec: 0,
      triggeredDurationSec: 30,
      postTriggeredAction: 'disableAfter',
    })
    await h.device.armWith('away')
    h.device.triggerFromRule(ref(RULE_A, PIR))
    h.device.bypassInput(bypassOf(RULE_A, PIR))
    vi.advanceTimersByTime(31_000)
    expect(h.device.currentState()).toBe('disarmed')
    expect(h.device.inputBypasses()).toEqual([])
    h.device.stopCountdown()
  })
})
