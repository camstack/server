import { describe, expect, it } from 'vitest'
import {
  classifyNodeExit,
  RESTART_INTENT_MAX_AGE_MS,
  summarizeNodeRootStatus,
  toNodeRootStateView,
  type RestartIntentMarker,
} from '../node-supervisor'

const NOW = 1_700_000_000_000

describe('classifyNodeExit', () => {
  const freshMarker: RestartIntentMarker = {
    requestedAtMs: NOW - 3_000,
    reason: 'server-update: @camstack/server@1.2.3',
  }

  it('classifies a parent-initiated stop as parent-intentional (no marker consulted)', () => {
    expect(
      classifyNodeExit({ wasParentIntentional: true, restartIntent: freshMarker, nowMs: NOW }),
    ).toEqual({ kind: 'parent-intentional' })
  })

  it('classifies a fresh restart-intent marker as an update-restart', () => {
    expect(
      classifyNodeExit({ wasParentIntentional: false, restartIntent: freshMarker, nowMs: NOW }),
    ).toEqual({ kind: 'update-restart' })
  })

  it('classifies an exit with no marker as a crash', () => {
    expect(
      classifyNodeExit({ wasParentIntentional: false, restartIntent: null, nowMs: NOW }),
    ).toEqual({ kind: 'crash' })
  })

  it('treats a STALE marker as a crash (orphaned by a hard quit)', () => {
    const stale: RestartIntentMarker = {
      requestedAtMs: NOW - RESTART_INTENT_MAX_AGE_MS - 1,
      reason: 'server-update: old',
    }
    expect(
      classifyNodeExit({ wasParentIntentional: false, restartIntent: stale, nowMs: NOW }),
    ).toEqual({ kind: 'crash' })
  })

  it('treats a marker from the future (clock skew) as a crash', () => {
    const future: RestartIntentMarker = { requestedAtMs: NOW + 5_000, reason: 'skew' }
    expect(
      classifyNodeExit({ wasParentIntentional: false, restartIntent: future, nowMs: NOW }),
    ).toEqual({ kind: 'crash' })
  })

  it('honours a marker exactly at the freshness boundary', () => {
    const boundary: RestartIntentMarker = {
      requestedAtMs: NOW - RESTART_INTENT_MAX_AGE_MS,
      reason: 'boundary',
    }
    expect(
      classifyNodeExit({ wasParentIntentional: false, restartIntent: boundary, nowMs: NOW }),
    ).toEqual({ kind: 'update-restart' })
  })
})

describe('summarizeNodeRootStatus', () => {
  it('labels the status line by role (hub)', () => {
    expect(summarizeNodeRootStatus(null, 'hub')).toBe('Hub: seed (no installed version)')
  })

  it('labels the status line by role (agent)', () => {
    expect(summarizeNodeRootStatus(null, 'agent')).toBe('Agent: seed (no installed version)')
  })

  it('reports an applying update while a version is pending', () => {
    expect(
      summarizeNodeRootStatus(
        { currentVersion: '1.2.0', pendingVersion: '1.3.0', rolledBack: false },
        'hub',
      ),
    ).toBe('Hub: applying update v1.3.0…')
  })

  it('reports the confirmed current version', () => {
    expect(
      summarizeNodeRootStatus(
        { currentVersion: '1.2.0', pendingVersion: null, rolledBack: false },
        'agent',
      ),
    ).toBe('Agent: v1.2.0')
  })

  it('flags a rolled-back update while keeping the surviving version', () => {
    expect(
      summarizeNodeRootStatus(
        { currentVersion: '1.2.0', pendingVersion: null, rolledBack: true },
        'hub',
      ),
    ).toBe('Hub: v1.2.0 (rolled back — update failed)')
  })

  it('reports the seed on a rollback all the way down', () => {
    expect(
      summarizeNodeRootStatus(
        { currentVersion: null, pendingVersion: null, rolledBack: true },
        'hub',
      ),
    ).toBe('Hub: seed (rolled back — update failed)')
  })

  it('reports the seed when nothing is installed and nothing pending', () => {
    expect(
      summarizeNodeRootStatus(
        { currentVersion: null, pendingVersion: null, rolledBack: false },
        'agent',
      ),
    ).toBe('Agent: seed')
  })
})

describe('toNodeRootStateView', () => {
  it('extracts the tray-relevant fields from a full state.json payload', () => {
    const view = toNodeRootStateView({
      schemaVersion: 1,
      currentVersion: '1.2.0',
      previousVersion: '1.1.0',
      pendingBoot: { version: '1.3.0', fromVersion: '1.2.0', requestedAtMs: 1, bootAttempts: 1 },
      rolledBack: null,
    })
    expect(view).toEqual({ currentVersion: '1.2.0', pendingVersion: '1.3.0', rolledBack: false })
  })

  it('marks rolledBack when the state carries a rollback record', () => {
    const view = toNodeRootStateView({
      currentVersion: '1.2.0',
      pendingBoot: null,
      rolledBack: { fromVersion: '1.3.0', toVersion: '1.2.0', atMs: 1, reason: 'x' },
    })
    expect(view).toEqual({ currentVersion: '1.2.0', pendingVersion: null, rolledBack: true })
  })

  it('returns null for a non-object payload', () => {
    expect(toNodeRootStateView(null)).toBeNull()
    expect(toNodeRootStateView('nope')).toBeNull()
  })

  it('tolerates a bare/empty state object', () => {
    expect(toNodeRootStateView({})).toEqual({
      currentVersion: null,
      pendingVersion: null,
      rolledBack: false,
    })
  })
})
