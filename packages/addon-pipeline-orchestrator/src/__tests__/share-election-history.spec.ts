import type { RunnerLocalLoad } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { pickInferenceDevice } from '../device-balancer.js'
import { electNodeByShare } from '../session-share-placement.js'
import { ShareElectionHistory } from '../share-election-history.js'

function tally(keys: readonly (string | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) if (k !== undefined) out[k] = (out[k] ?? 0) + 1
  return out
}

function sequentialDevices(
  eligible: Record<string, number>,
  n: number,
  history: ShareElectionHistory | undefined,
): Record<string, number> {
  const keys = Object.keys(eligible)
  const picks = Array.from({ length: n }, () => {
    const s = pickInferenceDevice({
      eligible,
      loads: keys.map((deviceKey) => ({ deviceKey, attachedCameras: 0 })),
      policy: 'share',
      ...(history !== undefined ? { shareHistory: history, historyScope: 'amd' } : {}),
    })
    return s.kind === 'selected' ? s.deviceKey : undefined
  })
  return tally(picks)
}

describe('share election over sessions that never overlap', () => {
  const corals = { 'edgetpu:pci': 100, 'edgetpu:pci:1': 100, 'edgetpu:usb': 100 }

  it('without history the first key takes everything (the observed 30/0/0)', () => {
    expect(sequentialDevices(corals, 30, undefined)).toEqual({ 'edgetpu:pci': 30 })
  })

  it('three equal Corals get 10 sessions each', () => {
    expect(sequentialDevices(corals, 30, new ShareElectionHistory())).toEqual({
      'edgetpu:pci': 10,
      'edgetpu:pci:1': 10,
      'edgetpu:usb': 10,
    })
  })

  it('weights 100:100:10 split in proportion', () => {
    const c = sequentialDevices({ a: 100, b: 100, c: 10 }, 210, new ShareElectionHistory())
    expect(c['a']).toBeGreaterThanOrEqual(98)
    expect(c['a']).toBeLessThanOrEqual(102)
    expect(c['c']).toBeGreaterThanOrEqual(8)
    expect(c['c']).toBeLessThanOrEqual(12)
  })

  it('counts are per scope and fade with time', () => {
    let now = 0
    const h = new ShareElectionHistory(() => now, 1000)
    h.noteElected('n1', 'cpu')
    expect(h.recent('n2', 'cpu')).toBe(0)
    expect(h.recent('n1', 'cpu')).toBe(1)
    now = 1000
    expect(h.recent('n1', 'cpu')).toBeCloseTo(0.5)
  })

  it('the node tier splits sequential sessions by detectWeight too', () => {
    const history = new ShareElectionHistory()
    const nodes = ['hub', 'mac']
    const loads: RunnerLocalLoad[] = nodes.map((nodeId) => ({
      nodeId,
      attachedCameras: 0,
      activeCameras: 0,
      avgInferenceFps: 0,
      avgInferenceTimeMs: 0,
      queueDepthTotal: 0,
      devices: [],
      hardware: { hasGpu: false },
    }))
    const picks = Array.from({ length: 40 }, () => {
      const e = electNodeByShare({
        loads,
        eligible: nodes,
        weights: { hub: 100, mac: 100 },
        caps: {},
        runningByNode: new Map(),
        history,
      })
      return e.kind === 'elected' ? e.key : undefined
    })
    expect(tally(picks)).toEqual({ hub: 20, mac: 20 })
  })
})
