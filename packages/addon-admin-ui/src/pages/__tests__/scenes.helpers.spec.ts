import type { SceneMonitor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildSceneRows, lastTransitionAt, type SceneCamera, sceneRank } from '../scenes.helpers.js'

const BASE: SceneMonitor = {
  id: 'm1',
  label: 'Immondizia',
  roi: { kind: 'rect', x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  enabled: true,
  triggerMode: 'both',
  check: { mode: 'similarity', threshold: 0.8, hysteresisCount: 3 },
  states: [
    { id: 's1', label: 'baseline', references: [], referenceCount: 0, currentlyMatched: true },
  ],
  currentStateId: 's1',
  lastCheckedAt: 1_000,
  lastConfidence: 0.9,
  currentCondition: 'day',
  availability: 'ok',
  unavailableReason: null,
  baselineStateId: 's1',
  emit: 'latched',
  verdict: 'matched',
  latched: false,
  armedAt: 100,
  divergedAt: null,
  restoredAt: null,
  quietSeconds: 60,
  minObservationSpacingSec: 120,
  anchorThreshold: 0.7,
  autoRestore: false,
  onUncoveredCondition: 'skip',
  suspendedCondition: null,
  unavailable: null,
  coveredConditions: ['day'],
}

function monitor(patch: Partial<SceneMonitor>): SceneMonitor {
  return { ...BASE, ...patch }
}

const CAMERAS: readonly SceneCamera[] = [
  { deviceId: 101, deviceName: 'Garden' },
  { deviceId: 102, deviceName: 'Cancello' },
]

describe('sceneRank', () => {
  it('puts a latched scene first — it is what the operator opened the page for', () => {
    expect(sceneRank(monitor({ latched: true, verdict: 'matched' }))).toBe(0)
  })

  it('ranks a live divergence below a latch but above everything else', () => {
    expect(sceneRank(monitor({ verdict: 'diverged' }))).toBe(1)
  })

  it("ranks can't-tell and not-armed ABOVE normal — both mean the scene is not working", () => {
    const cantTell = sceneRank(monitor({ verdict: 'unknown', unavailable: 'no-snapshot' }))
    const notArmed = sceneRank(monitor({ states: [] }))
    const normal = sceneRank(monitor({}))
    expect(cantTell).toBeLessThan(normal)
    expect(notArmed).toBeLessThan(normal)
  })
})

describe('lastTransitionAt', () => {
  it('is the most recent of divergedAt / restoredAt', () => {
    expect(lastTransitionAt(monitor({ divergedAt: 500, restoredAt: 900 }))).toBe(900)
    expect(lastTransitionAt(monitor({ divergedAt: 900, restoredAt: 500 }))).toBe(900)
  })

  it('ignores lastCheckedAt — a scene checked every 60s has not transitioned', () => {
    expect(lastTransitionAt(monitor({ lastCheckedAt: 99_999 }))).toBeNull()
  })
})

describe('buildSceneRows', () => {
  it('flattens across cameras and names each row with its camera', () => {
    const rows = buildSceneRows(CAMERAS, [
      { deviceId: 101, monitors: [monitor({ id: 'a' })] },
      { deviceId: 102, monitors: [monitor({ id: 'b' })] },
    ])
    expect(rows.map((r) => [r.deviceId, r.deviceName, r.monitor.id])).toEqual([
      [102, 'Cancello', 'b'],
      [101, 'Garden', 'a'],
    ])
  })

  it('orders by urgency, not alphabetically', () => {
    const rows = buildSceneRows(CAMERAS, [
      { deviceId: 101, monitors: [monitor({ id: 'normal' })] },
      {
        deviceId: 102,
        monitors: [
          monitor({ id: 'latched', latched: true, verdict: 'diverged', divergedAt: 5 }),
          monitor({ id: 'unknown', verdict: 'unknown', unavailable: 'no-snapshot' }),
        ],
      },
    ])
    expect(rows.map((r) => r.monitor.id)).toEqual(['latched', 'unknown', 'normal'])
  })

  it('sorts a never-transitioned scene AFTER one that moved, inside the same rank', () => {
    const rows = buildSceneRows(CAMERAS, [
      {
        deviceId: 101,
        monitors: [
          monitor({ id: 'never', label: 'A' }),
          monitor({ id: 'moved', label: 'B', restoredAt: 9_000 }),
        ],
      },
    ])
    expect(rows.map((r) => r.monitor.id)).toEqual(['moved', 'never'])
  })

  it('contributes no rows for a camera with no scenes', () => {
    const rows = buildSceneRows(CAMERAS, [
      { deviceId: 101, monitors: [] },
      { deviceId: 102, monitors: [] },
    ])
    expect(rows).toEqual([])
  })

  it('falls back to a numbered label when the camera is not in the list', () => {
    const rows = buildSceneRows([], [{ deviceId: 42, monitors: [monitor({})] }])
    expect(rows[0]?.deviceName).toBe('Camera 42')
  })
})
