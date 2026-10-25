/**
 * Shared builders for the D683 Task 16 specs (`track-store-adopt.spec.ts`,
 * `track-alias-store.spec.ts`, `track-close-gate.spec.ts`).
 */
import type { LabelAttribution, SettingsStoreClient } from '@camstack/types'
import { EMPTY_MOVED_PROBE, type MovedProbe } from '../pipeline/stationary/promotion-plan.js'
import { wireTrackAliasLedger } from '../store/event-ledger-wiring.js'
import { TrackAliasStore } from '../store/track-alias-store.js'
import {
  type MutableAudioLabelAgg,
  type MutableTrackState,
  TRACKS_COLLECTION,
  TrackStore,
  type TrackStoreConfig,
} from '../store/track-store.js'
import { instrumentRecords, makeAnalyticsRecords } from './fake-records.js'
import { makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

/** A `TrackAliasStore` over a fresh records world. */
export async function buildAliasStoreForTest(): Promise<TrackAliasStore> {
  const world = await makeAnalyticsRecords()
  return new TrackAliasStore({
    aliasLedger: wireTrackAliasLedger({ records: world.records }),
  })
}

/**
 * The same, wrapped so every `get` round trip is counted — review 2 L5: an id
 * that is not an alias must cost ONE store read, not one per `resolve` call.
 */
export async function buildCountingAliasStoreForTest(): Promise<{
  readonly aliases: TrackAliasStore
  readonly gets: () => number
}> {
  const counting = instrumentRecords((await makeAnalyticsRecords()).records)
  return {
    aliases: new TrackAliasStore({
      aliasLedger: wireTrackAliasLedger({ records: counting.records }),
    }),
    gets: counting.gets,
  }
}

/** Test-only options of {@link buildTrackStoreForTest} — never a production option. */
export interface TrackStoreForTestOptions extends Partial<TrackStoreConfig> {
  /** Spy on every track ROW write (`set` on the tracks collection), by key — a
   *  wrapper over the fake store's write, for ordering assertions (D683 Task 18). */
  readonly onPersist?: (trackId: string) => void
}

/** A fresh `TrackStore` over a fresh fake settings store, as
 *  `track-store.spec.ts` builds it — `config` overrides `ttlMs` etc. */
export function buildTrackStoreForTest(options?: TrackStoreForTestOptions): TrackStore {
  const fake = makeFakeSettingsStore()
  const { onPersist, ...config } = options ?? {}
  const client: SettingsStoreClient =
    onPersist === undefined
      ? fake.client
      : {
          ...fake.client,
          set: {
            mutate: async (input: { collection: string; key: string; value: unknown }) => {
              if (input.collection === TRACKS_COLLECTION) onPersist(input.key)
              return fake.client.set.mutate(input)
            },
          },
        }
  return new TrackStore({
    store: client,
    logger: makeSilentLogger(),
    ...(options !== undefined ? { config } : {}),
  })
}

/** A complete `upsert` input for one sighting. */
export function sighting(
  trackId: string,
  t: number,
  x: number,
  over: { readonly deviceId?: number; readonly zones?: readonly string[] } = {},
): Parameters<TrackStore['upsert']>[0] {
  return {
    trackId,
    deviceId: over.deviceId ?? 1,
    className: 'person',
    matched: true,
    state: 'moving',
    timestamp: t,
    position: {
      x,
      y: 100,
      timestamp: t,
      bbox: { x, y: 100, w: 100, h: 200 },
      source: 'frame',
      score: 0.9,
    },
    zones: over.zones ?? [],
  }
}

/** A per-label audio aggregate, as `fullRow`'s `audio` sugar takes it. */
export interface FullRowAudio {
  readonly count: number
  readonly peakScore: number
  readonly firstAt: number
  readonly lastAt: number
}

/**
 * Overrides for {@link fullRow}. Any real `MutableTrackState` field may be
 * set directly (an explicit `undefined` REMOVES it from the built row —
 * ordinary object-spread semantics); `positionsAt` and `audio` are sugar for
 * the two fields (`positions`, `audioLabels`) that are not scalars.
 */
export type FullRowOverrides = Partial<Omit<MutableTrackState, 'positions' | 'audioLabels'>> & {
  readonly positionsAt?: readonly number[]
  readonly audio?: Readonly<Record<string, FullRowAudio>>
}

function audioLabelsFrom(
  audio: Readonly<Record<string, FullRowAudio>>,
): Map<string, MutableAudioLabelAgg> {
  return new Map(Object.entries(audio).map(([label, agg]) => [label, { ...agg }]))
}

const FULL_ROW_LABEL_META: LabelAttribution = {
  stepId: 'step-tier1',
  decidedAt: 500,
}
const FULL_ROW_SUB_LABEL_META: LabelAttribution = {
  stepId: 'step-tier2',
  decidedAt: 600,
}
const FULL_ROW_AUDIO: Readonly<Record<string, FullRowAudio>> = {
  bark: { count: 1, peakScore: 0.5, firstAt: 100, lastAt: 200 },
}

/**
 * A `MutableTrackState` with EVERY optional field populated (label tiers with
 * their attribution, snapshot bookkeeping, importance, audio, operator flags,
 * pipeline flags, provenance, positions) — so a merge rule the table forgets
 * shows up as `undefined` against a field a real row would carry, rather than
 * being masked by both sides already being empty.
 *
 * `keptAtPromotion` is deliberately left ABSENT by default (as most real rows
 * are — it is set only by a registry promotion): pass it explicitly to test
 * its merge.
 */
export function fullRow(trackId: string, over: FullRowOverrides = {}): MutableTrackState {
  const { positionsAt, audio, ...rest } = over
  const positions = (positionsAt ?? [0]).map((t) => ({
    x: t,
    y: 100,
    timestamp: t,
    bbox: { x: t, y: 100, w: 100, h: 200 },
    source: 'frame' as const,
    score: 0.9,
  }))
  const base: MutableTrackState = {
    trackId,
    deviceId: 1,
    className: 'person',
    label: 'dog',
    labelScore: 0.9,
    labelMeta: FULL_ROW_LABEL_META,
    subLabel: 'Rex',
    subLabelScore: 0.8,
    subLabelMeta: FULL_ROW_SUB_LABEL_META,
    firstSeen: positions[0]?.timestamp ?? 0,
    lastSeen: positions.at(-1)?.timestamp ?? 0,
    positions,
    snapshots: [],
    zonesVisited: ['Uscio'],
    classes: ['person'],
    totalDistance: 42,
    state: 'moving',
    active: true,
    lastSnapshotAt: 1500,
    lastSnapshotBbox: { x: 10, y: 10, w: 50, h: 80 },
    snapshotPending: {
      at: 1500,
      previous: { at: 1000, bbox: undefined },
      priorRollbacks: 0,
    },
    snapshotRollbacks: 1,
    importance: 3,
    bestEventId: 'event-1',
    importanceReason: 'entered',
    audioLabels: audioLabelsFrom(audio ?? FULL_ROW_AUDIO),
    retrainStatus: 'none',
    debug: true,
    debugNote: 'check this',
    favourited: true,
    benchPinned: true,
    hasFace: true,
    hasEmbeddedFace: true,
    hasRider: false,
    closedReason: 'stationary-promotion',
    provenance: { modelId: 'model-1', frameWidth: 1920, frameHeight: 1080 },
    openedPlacement: { nodeId: `${trackId}-open`, deviceKey: 'openvino:npu', modelId: 'model-1' },
    closedPlacement: { nodeId: `${trackId}-close`, deviceKey: 'edgetpu:pci', modelId: 'model-2' },
    movedProbe: EMPTY_MOVED_PROBE,
  }
  return { ...base, ...rest }
}

/** A `MovedProbe` that reads as moved (`probeMoved` → `true`). */
export const MOVED_PROBE: MovedProbe = {
  early: [],
  reference: null,
  run: 0,
  moved: true,
}
/** A `MovedProbe` that has not moved (`probeMoved` → `false`). */
export const STILL_PROBE: MovedProbe = EMPTY_MOVED_PROBE
