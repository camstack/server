/**
 * D705 on the REAL panel: a match that presses `alarm-panel.trigger` while the
 * entry delay is already running is refused as a trigger — and its subject still
 * reaches the triggered transition as a FOLLOWER, so the combined notification can
 * tile it beside the source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NcRuleFireRef } from '../../rule-engine.js'
import { NcAlarmPanelDevice, type NcAlarmPublishReport } from '../alarm-panel-device.js'
import { makePanelContext, type NcTestLogLine } from './panel-test-context.js'

const T0 = Date.UTC(2026, 9, 6, 2, 0, 0)
const GATE = 101
const DRIVE = 102

function fireRef(deviceId: number, trackId: string, at: number): NcRuleFireRef {
  return {
    ruleId: `rule-${deviceId}`,
    ruleName: `Intrusione ${deviceId}`,
    deviceId,
    recordId: `ev-${trackId}`,
    trackId,
    eventId: `ev-${trackId}`,
    className: 'person',
    timestamp: at,
  }
}

function build() {
  const config: Record<string, unknown> = {
    exitDelaySec: 0,
    entryDelaySec: 20,
    triggeredDurationSec: 0,
  }
  const logs: NcTestLogLine[] = []
  const reports: NcAlarmPublishReport[] = []
  const { ctx } = makePanelContext(config, logs)
  const panel = new NcAlarmPanelDevice(ctx)
  panel.setPublishHook((report) => reports.push(report))
  return { panel, logs, reports }
}

const triggeredOf = (reports: readonly NcAlarmPublishReport[]) =>
  reports.map((r) => r.transition).find((t) => t?.kind === 'alarm-triggered')

describe('a match during the entry delay rides the triggered notification (D705)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the triggered transition carries the source AND the follower, in arrival order', async () => {
    const h = build()
    await h.panel.armWith('away')
    const source = fireRef(GATE, 'trk-gate', T0)
    h.panel.triggerFromRule(source)
    expect(h.panel.currentState()).toBe('pending')

    vi.setSystemTime(T0 + 5_000)
    const follower = fireRef(DRIVE, 'trk-drive', T0 + 5_000)
    h.panel.triggerFromRule(follower)
    // Still ONE countdown: the second press did not restart or fire anything.
    expect(h.panel.currentState()).toBe('pending')
    const joined = h.logs.find((l) => l.message.includes('joined the running entry delay'))
    expect(joined?.deviceId).toBe(DRIVE)

    await vi.advanceTimersByTimeAsync(16_000)
    expect(h.panel.currentState()).toBe('triggered')
    const fired = triggeredOf(h.reports)
    expect(fired?.source).toEqual(source)
    expect(fired?.followers).toEqual([follower])
  })

  it('a trigger nobody followed carries no followers — the D126 row, unchanged', async () => {
    const h = build()
    await h.panel.armWith('away')
    h.panel.triggerFromRule(fireRef(GATE, 'trk-gate', T0))
    await vi.advanceTimersByTimeAsync(21_000)
    const fired = triggeredOf(h.reports)
    expect(fired?.source?.trackId).toBe('trk-gate')
    expect(fired).not.toHaveProperty('followers')
  })

  it('a match AFTER the alarm triggered joins nothing — that notification has already left', async () => {
    const h = build()
    await h.panel.armWith('away')
    h.panel.triggerFromRule(fireRef(GATE, 'trk-gate', T0))
    await vi.advanceTimersByTimeAsync(21_000)
    h.panel.triggerFromRule(fireRef(DRIVE, 'trk-drive', T0 + 21_000))
    expect(h.logs.some((l) => l.message.includes('joined the running entry delay'))).toBe(false)
  })

  it('the same subject pressing twice is named, not tiled twice', async () => {
    const h = build()
    await h.panel.armWith('away')
    h.panel.triggerFromRule(fireRef(GATE, 'trk-gate', T0))
    h.panel.triggerFromRule({ ...fireRef(GATE, 'trk-gate', T0 + 1_000), ruleId: 'other-rule' })
    const line = h.logs.find((l) => l.message.includes('not added to the alarm picture'))
    expect(line?.deviceId).toBe(GATE)
    expect(line?.meta?.['reason']).toBe('duplicate')
    await vi.advanceTimersByTimeAsync(21_000)
    expect(triggeredOf(h.reports)).not.toHaveProperty('followers')
  })

  it('a disarm mid-countdown drops the followers with the incident', async () => {
    const h = build()
    await h.panel.armWith('away')
    h.panel.triggerFromRule(fireRef(GATE, 'trk-gate', T0))
    h.panel.triggerFromRule(fireRef(DRIVE, 'trk-drive', T0 + 1_000))
    await h.panel.disarm()
    await h.panel.armWith('away')
    h.panel.triggerFromRule(fireRef(GATE, 'trk-gate-2', T0 + 2_000))
    await vi.advanceTimersByTimeAsync(21_000)
    const fired = triggeredOf(h.reports)
    expect(fired?.source?.trackId).toBe('trk-gate-2')
    expect(fired).not.toHaveProperty('followers')
  })
})
