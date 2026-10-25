/**
 * The D189 class rewrite: naked audio macro → the taxonomy macro `audio`.
 *
 * The decision rule is tested against RAW rows, because that is what the pass
 * sees — hydrating through `rowToTrack` would apply the read-side compat and
 * hide the very rows this is looking for.
 *
 * The runner tests pin the three properties that make a boot-time rewrite safe
 * to leave running: it is idempotent, it is marker-gated, and a row that fails
 * to write is COUNTED and logged rather than passed over in silence.
 */

import type { SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type LogLine, makeRecordingLogger } from '../../__tests__/boot-analytics.js'
import { type FakeSettingsStore, makeFakeSettingsStore } from '../../__tests__/test-helpers.js'
import { makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import {
  AUDIO_CLASS_MIGRATION_MARKER_KEY,
  decideAudioClassRowMigration,
  runAudioTrackClassMigration,
} from '../audio-track-class-migration.js'
import { MigrationMarkerStore } from '../migration-marker-store.js'

const COLLECTION = 'pipeline-analytics:tracks'

function legacyRow(className: string, extra: Record<string, unknown> = {}) {
  return {
    source: 'audio',
    className,
    deviceId: 101,
    firstSeen: 1_000,
    lastSeen: 2_000,
    audioLabels: [{ label: className, peakScore: 0.9, count: 1, firstAt: 1_000, lastAt: 2_000 }],
    ...extra,
  }
}

describe('decideAudioClassRowMigration', () => {
  it('rewrites a naked audio macro to the taxonomy macro', () => {
    expect(decideAudioClassRowMigration(legacyRow('speech'))).toEqual({ className: 'audio' })
  })

  it('leaves a row that already speaks the contract alone (idempotent)', () => {
    expect(decideAudioClassRowMigration(legacyRow('audio'))).toBeNull()
  })

  it('never touches a non-audio row, even one whose class collides', () => {
    const pipelineAnimal = { ...legacyRow('animal'), source: 'pipeline' }
    expect(decideAudioClassRowMigration(pipelineAnimal)).toBeNull()
  })

  it('never touches a row with no source recorded', () => {
    const noSource = { ...legacyRow('speech'), source: undefined }
    expect(decideAudioClassRowMigration(noSource)).toBeNull()
  })

  /**
   * The back-stop. All 576 live rows carry labels, so this branch is expected
   * to be unreachable — but the rewrite must never be the step that destroys
   * the only copy of what was heard.
   */
  it('carries the naked class onto audioLabels when the row has none', () => {
    const bare = { source: 'audio', className: 'glass_breaking', firstSeen: 5, lastSeen: 9 }
    expect(decideAudioClassRowMigration(bare)).toEqual({
      className: 'audio',
      audioLabels: [{ label: 'glass_breaking', peakScore: 0, count: 1, firstAt: 5, lastAt: 9 }],
    })
  })

  it('treats an EMPTY audioLabels array as no labels', () => {
    const empty = {
      source: 'audio',
      className: 'water',
      firstSeen: 5,
      lastSeen: 9,
      audioLabels: [],
    }
    const patch = decideAudioClassRowMigration(empty)
    expect(patch?.['audioLabels']).toMatchObject([{ label: 'water' }])
  })
})

/**
 * The REAL in-memory `SettingsStoreClient` this package's specs boot against —
 * not a hand-shaped literal behind a cast. A fake that has to be cast into
 * position is a fake free to disagree with production, and this repo has twice
 * had a green test because of one.
 */
function makeStore(
  rows: ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
): FakeSettingsStore {
  const store = makeFakeSettingsStore()
  store.seed(
    COLLECTION,
    rows.map((r) => ({ id: r.id, data: r.data })),
  )
  return store
}

function audioRows(store: FakeSettingsStore): Record<string, unknown>[] {
  return [...(store.data.get(COLLECTION)?.values() ?? [])]
}

const NOW = (): number => 42

async function migrationDeps(store: FakeSettingsStore, logs: LogLine[] = []) {
  const world = await makeAnalyticsRecords()
  return {
    store: store.client,
    markers: MigrationMarkerStore.of(world.records),
    logger: makeRecordingLogger(logs),
    now: NOW,
  }
}

describe('runAudioTrackClassMigration', () => {
  it('rewrites only the legacy audio rows and marks itself complete', async () => {
    const store = makeStore([
      { id: 'a', data: legacyRow('speech') },
      { id: 'b', data: { ...legacyRow('animal'), source: 'pipeline' } },
      { id: 'c', data: legacyRow('audio') },
      { id: 'd', data: legacyRow('animal') },
    ])
    const logs: LogLine[] = []
    const deps = await migrationDeps(store, logs)
    const stats = await runAudioTrackClassMigration(deps, COLLECTION)

    expect(stats).toMatchObject({ scanned: 4, rewritten: 2, labelsRecovered: 0, skipped: 2 })
    expect(stats?.truncated).toBe(false)
    // The rows themselves, read back — the pipeline row keeps its class and the
    // two audio rows converge on the taxonomy macro.
    const byId = new Map(audioRows(store).map((r) => [r['id'], r]))
    expect(
      audioRows(store)
        .map((r) => r['className'])
        .sort(),
    ).toEqual(['animal', 'audio', 'audio', 'audio'])
    expect(byId.size).toBeGreaterThan(0)
    expect(await deps.markers.has(AUDIO_CLASS_MIGRATION_MARKER_KEY)).toBe(true)
  })

  it('short-circuits entirely when the marker is already set', async () => {
    const store = makeStore([{ id: 'a', data: legacyRow('speech') }])
    const deps = await migrationDeps(store)
    await deps.markers.set(AUDIO_CLASS_MIGRATION_MARKER_KEY, { completedAt: 1, rewritten: 0 })

    const stats = await runAudioTrackClassMigration(deps, COLLECTION)
    expect(stats).toBeNull()
    expect(audioRows(store)[0]?.['className']).toBe('speech')
  })

  it('a re-run over already-migrated rows rewrites nothing (idempotent)', async () => {
    const store = makeStore([
      { id: 'a', data: legacyRow('audio') },
      { id: 'b', data: legacyRow('audio') },
    ])
    const stats = await runAudioTrackClassMigration(await migrationDeps(store), COLLECTION)
    expect(stats).toMatchObject({ scanned: 2, rewritten: 0, skipped: 2 })
  })

  /**
   * A row the store refuses must be COUNTED and logged, never passed over in
   * silence — a rewrite that quietly declined looks exactly like a row that was
   * never legacy, and the next boot's `rewritten: 0` would then read as
   * "converged" when it is not.
   */
  it('counts a refused write as skipped and says so in the log', async () => {
    const store = makeStore([
      { id: 'a', data: legacyRow('speech') },
      { id: 'b', data: legacyRow('music') },
    ])
    const refusing: SettingsStoreClient = {
      ...store.client,
      update: {
        ...store.client.update,
        mutate: async (input: Parameters<SettingsStoreClient['update']['mutate']>[0]) => {
          if (input.id === 'a') throw new Error('write refused')
          return store.client.update.mutate(input)
        },
      },
    }
    const logs: LogLine[] = []
    const base = await migrationDeps(store)
    const stats = await runAudioTrackClassMigration(
      { ...base, store: refusing, logger: makeRecordingLogger(logs) },
      COLLECTION,
    )

    expect(stats).toMatchObject({ scanned: 2, rewritten: 1, skipped: 1 })
    const warned = logs.find((l) => l.level === 'warn')
    expect(warned?.message).toContain('audio track class migration row failed')
    // Every line about a device carries the numeric id, always under the same
    // key — a migration gap is asked per-camera or it cannot be asked at all.
    expect(warned).toMatchObject({
      extras: { tags: { deviceId: 101 }, meta: { id: 'a' } },
    })
  })
})
