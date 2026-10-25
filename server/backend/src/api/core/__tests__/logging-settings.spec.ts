/**
 * The logging settings DOCUMENT: the merge, the hierarchy, the deadline, and
 * the mirror.
 *
 * ## Neutralisations (each verified by disarming the fix and watching it fail)
 *
 *  - *"a patch MERGES"* — rebuild the record as `{ ...stored, ...patch }` in
 *    `mergeLevel` and arming a diagnostic silently erases the level somebody
 *    set an hour earlier. That is the failure `setAll` already merges to
 *    prevent, reintroduced one layer up.
 *  - *"`explicit` is returned next to `effective`"* — return only `effective`
 *    and the page cannot tell an override from an inheritance, so an operator
 *    clearing a node level believes they are clearing the cluster's.
 *  - *"a window expires by itself"* — persist a boolean instead of a deadline
 *    and a census somebody forgot taxes every request until the next release.
 *  - *"boot restores the REMAINDER"* — drop the restore and the boot storm,
 *    which is the only window worth measuring, is measured by nobody.
 *  - *"a failed read does not move the mirror"* — treat a throwing `get` as an
 *    empty record and one bad read silently resets the floor to `debug` and
 *    reopens the firehose. This repo has already rung a doorbell 0/3 that way
 *    (D49).
 */

import { describe, expect, it, vi } from 'vitest'
import { LoggingGate } from '@camstack/system'
import { HttpRequestCensus } from '../../trpc/http-request-census.js'
import {
  describeLayers,
  LOGGING_SETTINGS_KEY,
  LoggingSettingsService,
  mergeLevel,
  resolveLevel,
  toLoggingSettingsRecord,
} from '../logging-settings.js'
import { REQUEST_CENSUS_KEY, RequestCensusService } from '../request-census-settings.js'
import type { SettingsStoreGateway } from '../site-location.js'

const LOGGING_ROW = `|system-settings|${LOGGING_SETTINGS_KEY}`
const CENSUS_ROW = `|system-settings|${REQUEST_CENSUS_KEY}`

function makeStore(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(seed))
  const key = (i: { namespace?: string; collection: string; key: string }): string =>
    `${i.namespace ?? ''}|${i.collection}|${i.key}`
  const store: SettingsStoreGateway = {
    get: vi.fn(async (i) => rows.get(key(i)) ?? null),
    set: vi.fn(async (i) => {
      rows.set(key(i), i.value)
    }),
  }
  return { store, rows }
}

/** A store whose every call rejects — the settings-store cap not yet up. */
function brokenStore(): SettingsStoreGateway {
  return {
    get: vi.fn(async () => {
      throw new Error('settings-store unavailable: cap not registered yet')
    }),
    set: vi.fn(async () => {
      throw new Error('settings-store unavailable: cap not registered yet')
    }),
  }
}

function makeService(store: SettingsStoreGateway, nowMs = 1_000_000) {
  let now = nowMs
  const timers: { fn: () => void; at: number }[] = []
  const census = new HttpRequestCensus({
    now: () => now,
    schedule: (fn, ms) => {
      timers.push({ fn, at: now + ms })
    },
  })
  const gate = new LoggingGate()
  const requestCensus = new RequestCensusService({ census, store, now: () => now })
  const service = new LoggingSettingsService({
    store,
    gate,
    requestCensus,
    localNodeId: 'hub',
    now: () => now,
  })
  return {
    census,
    gate,
    service,
    advance: (ms: number) => {
      now += ms
    },
    /** One pass: a tick that reschedules must not spin forever here. */
    runPendingTimers: () => {
      const due = timers.splice(0, timers.length).filter((t) => t.at <= now)
      for (const timer of due) timer.fn()
    },
  }
}

// ── pure helpers ────────────────────────────────────────────────────

describe('toLoggingSettingsRecord', () => {
  it('reads only what it understands, and nothing from a non-object', () => {
    expect(toLoggingSettingsRecord(null)).toEqual({})
    expect(toLoggingSettingsRecord('nope')).toEqual({})
    expect(toLoggingSettingsRecord({ clusterLevel: 'shout' })).toEqual({})
    expect(
      toLoggingSettingsRecord({ clusterLevel: 'warn', nodeLevels: { hub: 'info', bad: 7 } }),
    ).toEqual({ clusterLevel: 'warn', nodeLevels: { hub: 'info' } })
  })
})

describe('resolveLevel — cluster → node, most specific wins', () => {
  it('falls back to the default when nothing is set anywhere', () => {
    expect(resolveLevel({}, 'hub')).toEqual({ level: 'debug', source: 'default' })
  })

  it('inherits the cluster level at a node that sets none', () => {
    expect(resolveLevel({ clusterLevel: 'info' }, 'hub')).toEqual({
      level: 'info',
      source: 'cluster',
    })
  })

  it('lets the node override the cluster', () => {
    expect(resolveLevel({ clusterLevel: 'info', nodeLevels: { hub: 'warn' } }, 'hub')).toEqual({
      level: 'warn',
      source: 'node',
    })
  })

  it("never shows one node's override at CLUSTER scope", () => {
    expect(resolveLevel({ nodeLevels: { hub: 'error' } }, null)).toEqual({
      level: 'debug',
      source: 'default',
    })
  })
})

describe('mergeLevel — a patch merges, it never replaces', () => {
  it('keeps every other node when one node is written', () => {
    const before = { clusterLevel: 'info' as const, nodeLevels: { hub: 'warn' as const } }

    const after = mergeLevel(before, 'agent-1', null, 'error', 5)

    expect(after).toEqual({
      clusterLevel: 'info',
      nodeLevels: { hub: 'warn', 'agent-1': 'error' },
      updatedAt: 5,
    })
  })

  it('keeps the node map when the CLUSTER level is written', () => {
    const after = mergeLevel({ nodeLevels: { hub: 'warn' } }, null, null, 'info', 5)

    expect(after).toEqual({ clusterLevel: 'info', nodeLevels: { hub: 'warn' }, updatedAt: 5 })
  })

  it('CLEARS only the addressed scope on null, leaving the rest alone', () => {
    const before = {
      clusterLevel: 'info' as const,
      nodeLevels: { hub: 'warn' as const, 'agent-1': 'error' as const },
    }

    expect(mergeLevel(before, 'hub', null, null, 5)).toEqual({
      clusterLevel: 'info',
      nodeLevels: { 'agent-1': 'error' },
      updatedAt: 5,
    })
    expect(mergeLevel(before, null, null, null, 5)).toEqual({
      nodeLevels: { hub: 'warn', 'agent-1': 'error' },
      updatedAt: 5,
    })
  })
})

describe('describeLayers', () => {
  it('reports a layer that inherits as `level: null`, not as its inherited value', () => {
    expect(describeLayers({ clusterLevel: 'info' }, 'hub')).toEqual([
      { scope: 'cluster', nodeId: null, component: null, level: 'info' },
      { scope: 'node', nodeId: 'hub', component: null, level: null },
    ])
  })
})

// ── the service ─────────────────────────────────────────────────────

describe('LoggingSettingsService.set — the patch merges', () => {
  it('leaves the level alone when the patch only arms a diagnostic', async () => {
    const { store, rows } = makeStore()
    const { service } = makeService(store)

    await service.set({ level: 'warn' })
    const after = await service.set({ diagnostics: [{ id: 'request-census', armMs: 120_000 }] })

    expect(after.effective).toEqual({ level: 'warn', levelSource: 'cluster' })
    expect(rows.get(LOGGING_ROW)).toMatchObject({ clusterLevel: 'warn' })
  })

  it('leaves an armed window running when the patch only sets a level', async () => {
    const { store } = makeStore()
    const { service, census } = makeService(store)

    await service.set({ diagnostics: [{ id: 'request-census', armMs: 120_000 }] })
    const after = await service.set({ level: 'error' }, 'hub')

    expect(census.armed).toBe(true)
    expect(after.activeWindows[0]?.armed).toBe(true)
    expect(after.effective).toEqual({ level: 'error', levelSource: 'node' })
  })
})

describe('LoggingSettingsService — effective vs explicit', () => {
  it('says WHICH layer supplied the effective level, and what each layer holds', async () => {
    const { store } = makeStore()
    const { service } = makeService(store)

    await service.set({ level: 'info' })
    await service.set({ level: 'warn' }, 'hub')

    const state = await service.get('hub')

    expect(state.scopeNodeId).toBe('hub')
    expect(state.effective).toEqual({ level: 'warn', levelSource: 'node' })
    expect(state.explicit.layers).toEqual([
      { scope: 'cluster', nodeId: null, component: null, level: 'info' },
      { scope: 'node', nodeId: 'hub', component: null, level: 'warn' },
    ])
  })

  it('distinguishes clearing an OVERRIDE from clearing what it inherits', async () => {
    const { store } = makeStore()
    const { service } = makeService(store)
    await service.set({ level: 'info' })
    await service.set({ level: 'warn' }, 'hub')

    const cleared = await service.set({ level: null }, 'hub')

    // The node inherits again, and SAYS it inherits — the cluster value is
    // untouched, which is the whole point of returning both blocks.
    expect(cleared.effective).toEqual({ level: 'info', levelSource: 'cluster' })
    expect(cleared.explicit.layers).toEqual([
      { scope: 'cluster', nodeId: null, component: null, level: 'info' },
      { scope: 'node', nodeId: 'hub', component: null, level: null },
    ])
  })

  it('moves the hot-path mirror to the LOCAL node effective level', async () => {
    const { store } = makeStore()
    const { service, gate } = makeService(store)

    await service.set({ level: 'warn' })

    expect(gate.destinationFloor).toBe('warn')
    expect(gate.restrictsDestinations).toBe(true)
  })
})

describe('LoggingSettingsService — a diagnostic carries a deadline', () => {
  it('reports the window with the time it has LEFT', async () => {
    const { store } = makeStore()
    const { service, advance } = makeService(store)

    const armed = await service.set({ diagnostics: [{ id: 'request-census', armMs: 120_000 }] })
    expect(armed.activeWindows[0]).toMatchObject({
      id: 'request-census',
      armed: true,
      remainingMs: 120_000,
      persisted: true,
    })

    advance(90_000)
    const later = await service.get()
    expect(later.activeWindows[0]?.remainingMs).toBe(30_000)
  })

  it('EXPIRES on its own, without anyone switching it off', async () => {
    const { store } = makeStore()
    const { service, census, advance, runPendingTimers } = makeService(store)
    await service.set({ diagnostics: [{ id: 'request-census', armMs: 120_000 }] })

    advance(120_001)
    // Nobody switched it off: the window closes on its own scheduled tick.
    runPendingTimers()

    const state = await service.get()
    expect(census.armed).toBe(false)
    expect(state.activeWindows[0]).toMatchObject({ armed: false, remainingMs: 0, armedUntilMs: 0 })
  })

  it('re-arms only the REMAINDER at boot, and never re-writes the deadline', async () => {
    const now = 1_000_000
    const { store, rows } = makeStore({
      [CENSUS_ROW]: { armedUntilMs: now + 60_000, reportEveryMs: 30_000, updatedAt: now - 10 },
    })
    const { service, census } = makeService(store, now)

    await service.restore()

    expect(census.armed).toBe(true)
    expect(census.armedUntilMs).toBe(now + 60_000)
    // Untouched: a restore that refreshed the deadline would make a forgotten
    // census immortal across restarts.
    expect(rows.get(CENSUS_ROW)).toEqual({
      armedUntilMs: now + 60_000,
      reportEveryMs: 30_000,
      updatedAt: now - 10,
    })
  })

  it('does not re-arm a window that already expired', async () => {
    const now = 1_000_000
    const { store } = makeStore({ [CENSUS_ROW]: { armedUntilMs: now - 1 } })
    const { service, census } = makeService(store, now)

    await service.restore()

    expect(census.armed).toBe(false)
  })

  it('restores the mirrored level at boot', async () => {
    const { store } = makeStore({ [LOGGING_ROW]: { clusterLevel: 'error' } })
    const { service, gate } = makeService(store)

    await service.restore()

    expect(gate.destinationFloor).toBe('error')
  })
})

describe('LoggingSettingsService — a failed read changes NOTHING', () => {
  it('leaves the mirror and an armed window exactly as they were', async () => {
    // Arm and set a level against a healthy store first.
    const { store, rows } = makeStore()
    const { service, gate, census } = makeService(store)
    await service.set({ level: 'warn' })
    await service.set({ diagnostics: [{ id: 'request-census', armMs: 120_000 }] })
    expect(gate.destinationFloor).toBe('warn')

    // The store now fails every read. Same gate, same census.
    const failing = brokenStore()
    const failingService = new LoggingSettingsService({
      store: failing,
      gate,
      requestCensus: new RequestCensusService({ census, store: failing }),
      localNodeId: 'hub',
    })

    const state = await failingService.get('hub')
    await failingService.restore()

    // Unknown is reported as unknown - and the live behaviour is untouched.
    expect(state.persisted).toBe(false)
    expect(gate.destinationFloor).toBe('warn')
    expect(gate.restrictsDestinations).toBe(true)
    expect(census.armed).toBe(true)
    // Nothing was written back over the good row either.
    expect(rows.get(LOGGING_ROW)).toMatchObject({ clusterLevel: 'warn' })
  })

  it('reports persisted: false when the WRITE fails, but still applies the level', async () => {
    const store = brokenStore()
    const { service, gate } = makeService(store)

    const state = await service.set({ level: 'error' })

    expect(state.persisted).toBe(false)
    expect(gate.destinationFloor).toBe('error')
  })
})
