/**
 * The scene reconcile tick, and the line it printed 60 times an hour.
 *
 * `SCENE_RELOAD_INTERVAL_MS` is 30s and the timer does
 * `store.load().then(() => store.pruneLatches())` on every notification/analytics
 * node — cross-node convergence, bounded staleness, correct by design (D8).
 * What was not correct is that `load()` announced itself unconditionally:
 *
 *     [SceneMonitor] scene state loaded {scenes=1 latches=1}
 *
 * Measured live 2026-08-25: that exact line, with those exact numbers, every 30
 * seconds. The count is genuinely worth shouting — the docblock is right that
 * "loaded 0" after a container recreate is the one line that explains why every
 * scene reads `unknown` — but only when it CHANGES. A number that is reprinted
 * unchanged twice a minute forever is how "loaded 0" gets scrolled past.
 *
 * The second thing these pin down is the read itself. `DurableLedger` defaults
 * to `limit: 100_000` and the docblock says the owner "sets it from the row set
 * it expects". Neither scene ledger set one — so the reconcile asked SQLite,
 * through hub-main's event loop, for up to a hundred thousand rows twice every
 * 30s, on a hub holding one scene and one latch. A bound nobody chose is not a
 * bound; it is the default wearing the word.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  SCENE_LEDGER_LOAD_LIMIT,
  type SceneLatchRow,
  SceneStore,
  sceneKey,
} from '../scene-store.js'

/** A latch row is the write-THROUGH half of the store, so a put is visible to
 *  the very next load — which is what a reconcile tick actually observes. */
function latch(deviceId: number, monitorId: string): SceneLatchRow {
  return {
    key: sceneKey(deviceId, monitorId),
    deviceId,
    monitorId,
    verdict: 'matched',
    unavailable: null,
    currentStateId: null,
    latched: false,
    armedAt: 1,
    divergedAt: null,
    restoredAt: null,
    lastCheckedAt: null,
    lastConfidence: null,
    currentCondition: null,
    updatedAt: 1,
  }
}

async function freshStore(): Promise<{
  readonly store: SceneStore
  readonly info: ReturnType<typeof vi.fn>
  readonly queries: () => readonly { kind: string; limit: number }[]
}> {
  const world = await makeAnalyticsRecords()
  const info = vi.fn()
  const logger = { ...makeSilentLogger(), info }
  return {
    store: new SceneStore({ records: world.records, logger }),
    info,
    queries: () => world.queries,
  }
}

describe('the reconcile tick announces a CHANGE, not a heartbeat', () => {
  it('the first load always says what it found — "loaded 0" is the line that matters', async () => {
    const { store, info } = await freshStore()
    await store.load()
    expect(info.mock.calls.filter((c) => String(c[0]).includes('scene state loaded'))).toHaveLength(
      1,
    )
  })

  it('an unchanged reload is SILENT — this fired every 30s on the live hub', async () => {
    const { store, info } = await freshStore()
    await store.putLatch(latch(102, 'gate'))
    await store.load()
    info.mockClear()
    await store.load()
    await store.load()
    await store.load()
    expect(info.mock.calls.filter((c) => String(c[0]).includes('scene state loaded'))).toHaveLength(
      0,
    )
  })

  it('a row APPEARING is a change and is announced', async () => {
    const { store, info } = await freshStore()
    await store.load()
    info.mockClear()
    await store.putLatch(latch(102, 'gate'))
    await store.load()
    const lines = info.mock.calls.filter((c) => String(c[0]).includes('scene state loaded'))
    expect(lines).toHaveLength(1)
  })

  it('a row DISAPPEARING is a change — a silent drop to 0 is the failure it exists to name', async () => {
    const { store, info } = await freshStore()
    await store.putLatch(latch(102, 'gate'))
    await store.load()
    info.mockClear()
    await store.deleteScene(102, 'gate')
    await store.load()
    expect(info.mock.calls.filter((c) => String(c[0]).includes('scene state loaded'))).toHaveLength(
      1,
    )
  })
})

describe('the reconcile read is BOUNDED by the row set it expects', () => {
  it('neither ledger asks for the 100_000-row default', async () => {
    const { store, queries } = await freshStore()
    await store.load()
    expect(queries()).toHaveLength(2)
    for (const q of queries()) {
      expect(q.limit).toBeGreaterThan(0)
      expect(q.limit).toBeLessThanOrEqual(SCENE_LEDGER_LOAD_LIMIT)
    }
    expect(SCENE_LEDGER_LOAD_LIMIT).toBeLessThan(100_000)
  })
})
