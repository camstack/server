import { describe, expect, it } from 'vitest'
import { handleNodeExit, type NodeExitDeps } from '../node-exit-handler'
import type { RestartIntentMarker } from '../node-supervisor'
import type { RespawnState } from '../renderer-diagnostics'

const NOW = 1_700_000_000_000
const FRESH: RestartIntentMarker = {
  requestedAtMs: NOW - 1_000,
  reason: 'server-update: x',
}

interface Harness {
  readonly deps: NodeExitDeps
  readonly calls: string[]
  readonly relaunchDelays: number[]
  state: RespawnState
}

function harness(
  over: Partial<NodeExitDeps> = {},
  marker: RestartIntentMarker | null = FRESH,
): Harness {
  const calls: string[] = []
  const relaunchDelays: number[] = []
  const h: Harness = {
    calls,
    relaunchDelays,
    state: { consecutiveCrashes: 2 },
    deps: {
      appQuitting: () => false,
      consumeRestartIntent: () => {
        calls.push('consume')
        return marker
      },
      now: () => NOW,
      getRespawnState: () => h.state,
      setRespawnState: (s) => {
        h.state = s
      },
      uptimeMs: () => 1_000,
      relaunch: (delayMs) => {
        calls.push('relaunch')
        relaunchDelays.push(delayMs)
      },
      refreshTray: () => calls.push('tray'),
      log: () => calls.push('log'),
      ...over,
    },
  }
  return h
}

describe('handleNodeExit', () => {
  it('consumes the marker and relaunches BEFORE the tray refresh and the log line', () => {
    const h = harness()
    handleNodeExit(h.deps, 0, null, false)
    expect(h.calls.indexOf('consume')).toBeLessThan(h.calls.indexOf('relaunch'))
    expect(h.calls.indexOf('relaunch')).toBeLessThan(h.calls.indexOf('tray'))
    expect(h.calls.indexOf('relaunch')).toBeLessThan(h.calls.indexOf('log'))
  })

  it('still relaunches an update restart when the tray refresh throws', () => {
    const h = harness({
      refreshTray: () => {
        throw new Error('tray destroyed')
      },
    })
    handleNodeExit(h.deps, 0, null, false)
    expect(h.relaunchDelays).toEqual([500])
    expect(h.state).toEqual({ consecutiveCrashes: 0 })
  })

  it('still relaunches a crash, with backoff, when the log line throws (EPIPE)', () => {
    const h = harness(
      {
        log: () => {
          throw new Error('EPIPE')
        },
      },
      null,
    )
    handleNodeExit(h.deps, 1, null, false)
    expect(h.relaunchDelays).toEqual([4_000])
    expect(h.state).toEqual({ consecutiveCrashes: 3 })
  })

  it('a marker that cannot be read is a crash, not a lost relaunch', () => {
    const h = harness({
      consumeRestartIntent: () => {
        throw new Error('EACCES')
      },
    })
    handleNodeExit(h.deps, 1, null, false)
    expect(h.relaunchDelays).toEqual([4_000])
  })

  it('never relaunches a stop the shell asked for, or once the app is quitting', () => {
    const intentional = harness()
    handleNodeExit(intentional.deps, 0, 'SIGTERM', true)
    expect(intentional.relaunchDelays).toEqual([])

    const quitting = harness({ appQuitting: () => true })
    handleNodeExit(quitting.deps, 0, null, false)
    expect(quitting.relaunchDelays).toEqual([])
    expect(quitting.calls).not.toContain('consume')
  })

  it('a forced kill (SIGKILL, shell-initiated or self-inflicted) with the marker is the planned restart, consumed once', () => {
    for (const code of [null, 137]) {
      const h = harness()
      handleNodeExit(h.deps, code, 'SIGKILL', false)
      expect(h.calls.filter((c) => c === 'consume')).toHaveLength(1)
      expect(h.calls.filter((c) => c === 'relaunch')).toHaveLength(1)
      expect(h.state.consecutiveCrashes).toBe(0)
    }
  })

  it('a SIGKILL without the marker is still a crash with backoff', () => {
    const h = harness({}, null)
    handleNodeExit(h.deps, null, 'SIGKILL', false)
    expect(h.state.consecutiveCrashes).toBe(3)
  })
})
