/**
 * Scene persistence — TWO stores, split because they are two different
 * classes of fact (the 2026-08-13 durable-value census vocabulary).
 *
 * | Store | Class | Contents | Write rate |
 * | --- | --- | --- | --- |
 * | `scenes` record kind (`ctx.records`) | CONFIG | roi, check, confirm, states, references (+ embeddings), thresholds | operator only |
 * | `pipeline-analytics:scene-latch` collection | LEDGER | armedAt / latched / divergedAt / restoredAt / verdict per (deviceId, monitorId) | one row per transition |
 *
 * **The split is load-bearing, not tidiness.** An operator editing the ROI must
 * not rewrite the latch, and the latch must not be lost when a scene is edited.
 * One table holding both would make every ROI drag a write to the one row that
 * records "the operator has not acknowledged this yet" — the exact fact nothing
 * else in the system can regenerate.
 *
 * The latch is `write-through`: a latched alarm that exists only in RAM would,
 * after a restart, read as never having fired, and the operator would never be
 * told the bin was taken. The config is `write-behind`: losing an ROI write
 * costs a redraw.
 *
 * ## Weight
 *
 * A CLIP ViT-B/32 embedding is 512 floats ≈ 6–10 KB as JSON, and each reference
 * carries two of them (the ROI crop and the whole-frame anchor). Bounded at
 * {@link SCENE_MAX_REFS_PER_CONDITION} references per condition and
 * {@link SCENE_MAX_CONDITIONS} conditions, so a scene row cannot exceed a few
 * hundred KB — written only when the operator captures. Without the bound a
 * capture loop would grow the analytics DB without one.
 */

import type {
  IScopedLogger,
  RecordsAccess,
  SceneMonitor,
  SceneUnavailable,
  SceneVerdict,
} from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../../durable/durable-ledger.js'
import { pipelineAnalyticsRecordKinds } from '../record-kinds.js'
import { SceneConfigLedger, type SceneConfigRow } from './scene-config-ledger.js'

export type { SceneConfigRow } from './scene-config-ledger.js'

/** Max references stored per lighting condition, per scene. */
export const SCENE_MAX_REFS_PER_CONDITION = 6
/** Max distinct lighting conditions a scene may hold references for. */
export const SCENE_MAX_CONDITIONS = 5

/** Legacy collection name — kept for the classification, the adoption mapper and docs. */
export const SCENE_COLLECTION = 'pipeline-analytics:scenes'

/**
 * @durable class=ledger owner=pipeline-analytics
 *   write="a CONFIRMED scene transition or a reset (armedAt/latched/divergedAt/restoredAt), write-through"
 *   retention="one row per (deviceId, monitorId); pruneExcept(the scene set) on every scene reload — bounded by the scenes collection, never by age"
 */
export const SCENE_LATCH_COLLECTION = 'pipeline-analytics:scene-latch'

const SCENE_LATCH_COLUMNS = [
  { name: 'key', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'monitorId', type: 'TEXT' as const, notNull: true },
  { name: 'verdict', type: 'TEXT' as const, notNull: true },
  { name: 'unavailable', type: 'TEXT' as const },
  { name: 'currentStateId', type: 'TEXT' as const },
  { name: 'latched', type: 'BOOLEAN' as const, notNull: true },
  { name: 'armedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'divergedAt', type: 'INTEGER' as const },
  { name: 'restoredAt', type: 'INTEGER' as const },
  { name: 'lastCheckedAt', type: 'INTEGER' as const },
  { name: 'lastConfidence', type: 'REAL' as const },
  { name: 'currentCondition', type: 'TEXT' as const },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
] as const

const SCENE_LATCH_INDEXES = [
  { name: 'idx_scene_latch_device', columns: ['deviceId'] as const },
] as const

/** The `(deviceId, monitorId)` identity both collections key on. */
export function sceneKey(deviceId: number, monitorId: string): string {
  return `${deviceId}:${monitorId}`
}

/** One persisted latch — the fact only this component ever held. */
export interface SceneLatchRow {
  readonly key: string
  readonly deviceId: number
  readonly monitorId: string
  readonly verdict: SceneVerdict
  readonly unavailable: SceneUnavailable | null
  readonly currentStateId: string | null
  readonly latched: boolean
  readonly armedAt: number
  readonly divergedAt: number | null
  readonly restoredAt: number | null
  readonly lastCheckedAt: number | null
  readonly lastConfidence: number | null
  readonly currentCondition: string | null
  readonly updatedAt: number
}

/**
 * Reseed cap for BOTH scene ledgers.
 *
 * `DurableLedger` defaults to 100_000 and its own docblock says the owner "sets
 * it from the row set it expects". Neither scene ledger did, so the 30s
 * reconcile asked SQLite — through hub-main's event loop, which is the
 * cluster's only queue (D181) — for up to a hundred thousand rows twice a tick,
 * on a hub holding one scene and one latch (measured live 2026-08-25). A bound
 * nobody chose is not a bound.
 *
 * A scene is an operator-drawn monitor on ONE camera and a latch is at most one
 * row per scene, so the row set is `cameras x monitors-per-camera`. 5_000 is
 * ~5 monitors on each of a thousand cameras — far past any installation this
 * ships to, and still small enough that a runaway write loop is CAUGHT by the
 * bound instead of being paged in whole.
 */
export const SCENE_LEDGER_LOAD_LIMIT = 5_000

const SCENE_LATCH_SPEC: DurableLedgerSpec<SceneLatchRow> = {
  collection: SCENE_LATCH_COLLECTION,
  columns: SCENE_LATCH_COLUMNS,
  indexes: SCENE_LATCH_INDEXES,
  loadLimit: SCENE_LEDGER_LOAD_LIMIT,
  writeMode: 'write-through',
  keyOf: (row) => row.key,
  toValue: (row) => ({
    deviceId: row.deviceId,
    monitorId: row.monitorId,
    verdict: row.verdict,
    unavailable: row.unavailable,
    currentStateId: row.currentStateId,
    latched: row.latched,
    armedAt: row.armedAt,
    divergedAt: row.divergedAt,
    restoredAt: row.restoredAt,
    lastCheckedAt: row.lastCheckedAt,
    lastConfidence: row.lastConfidence,
    currentCondition: row.currentCondition,
    updatedAt: row.updatedAt,
  }),
  fromRecord: latchFromRecord,
  deviceIdOf: (row) => row.deviceId,
}

export interface SceneStoreDeps {
  /** `ctx.records`, with the pipeline-analytics kinds already declared. */
  readonly records: Pick<RecordsAccess, 'kind'>
  readonly logger: IScopedLogger
}

/**
 * The two ledgers behind one façade. Callers never see the split, but they can
 * never accidentally write one when they meant the other either: the config
 * methods take a `SceneMonitor` and the latch methods take a `SceneLatchRow`.
 */
export class SceneStore {
  private readonly config: SceneConfigLedger
  private readonly latch: DurableLedger<SceneLatchRow>
  private readonly logger: IScopedLogger
  /** `scenes/latches` as last announced. Null until the first load, so the
   *  first one always speaks. */
  private lastLoggedCounts: string | null = null

  constructor(deps: SceneStoreDeps) {
    this.logger = deps.logger
    this.config = new SceneConfigLedger(
      deps.records.kind(pipelineAnalyticsRecordKinds.scenes),
      deps.logger,
      SCENE_LEDGER_LOAD_LIMIT,
    )
    this.latch = new DurableLedger({
      spec: SCENE_LATCH_SPEC,
      kind: deps.records.kind(pipelineAnalyticsRecordKinds['scene-latch']),
      logger: deps.logger,
    })
  }

  /**
   * Reseed both mirrors. The loaded COUNT is logged out loud on purpose: after
   * a container recreate, "loaded 0" is the one line that explains why every
   * scene suddenly reads `unknown`, and its absence is what turns a data loss
   * into a three-hour hunt.
   *
   * ON CHANGE ONLY, though — including the first load, where there is nothing
   * to compare against. This runs on the 30s `SCENE_RELOAD_INTERVAL_MS` tick on
   * every node, and it used to print unconditionally: measured live 2026-08-25,
   * `scene state loaded {scenes=1 latches=1}` every 30 seconds forever. A count
   * reprinted unchanged twice a minute is exactly how the "loaded 0" this line
   * exists for gets scrolled past.
   */
  async load(): Promise<void> {
    const scenes = await this.config.load()
    const latches = await this.latch.load()
    const counts = `${scenes.length}/${latches.length}`
    if (counts === this.lastLoggedCounts) return
    this.lastLoggedCounts = counts
    this.logger.info('scene state loaded', {
      meta: { scenes: scenes.length, latches: latches.length },
    })
  }

  listScenes(): readonly SceneConfigRow[] {
    return this.config.snapshot()
  }

  getScene(deviceId: number, monitorId: string): SceneConfigRow | undefined {
    return this.config.get(sceneKey(deviceId, monitorId))
  }

  putScene(deviceId: number, monitor: SceneMonitor, now: number): Promise<void> {
    return this.config.put({
      key: sceneKey(deviceId, monitor.id),
      deviceId,
      monitor,
      updatedAt: now,
    })
  }

  async deleteScene(deviceId: number, monitorId: string): Promise<void> {
    const key = sceneKey(deviceId, monitorId)
    await this.config.forget(key)
    await this.latch.forget(key)
  }

  getLatch(deviceId: number, monitorId: string): SceneLatchRow | undefined {
    return this.latch.get(sceneKey(deviceId, monitorId))
  }

  listLatches(): readonly SceneLatchRow[] {
    return this.latch.snapshot()
  }

  putLatch(row: SceneLatchRow): Promise<void> {
    return this.latch.put(row)
  }

  /**
   * Drop latch rows whose scene no longer exists. The active set is
   * AUTHORITATIVE — it is the config mirror the caller has just loaded — which
   * is the only condition under which a prune is legal (D130: a prune is work
   * DESTROYED on a fallible read).
   */
  pruneLatches(): Promise<number> {
    const active = new Set(this.config.snapshot().map((r) => r.key))
    return this.latch.pruneExcept(active)
  }
}

function nullableNumber(value: unknown): number | null {
  const n = Number(value)
  return value === null || value === undefined || !Number.isFinite(n) ? null : n
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function latchFromRecord(key: string, data: Record<string, unknown>): SceneLatchRow | null {
  const deviceId = Number(data['deviceId'])
  const armedAt = Number(data['armedAt'])
  const updatedAt = Number(data['updatedAt'])
  const monitorId = data['monitorId']
  const verdict = data['verdict']
  if (!Number.isFinite(deviceId) || !Number.isFinite(armedAt) || !Number.isFinite(updatedAt)) {
    return null
  }
  if (typeof monitorId !== 'string' || monitorId.length === 0) return null
  if (verdict !== 'matched' && verdict !== 'diverged' && verdict !== 'unknown') return null
  // BOOLEAN round-trips as a real boolean (real backend) or a 0/1 int (defensive).
  const rawLatched = data['latched']
  return {
    key,
    deviceId,
    monitorId,
    verdict,
    unavailable: unavailableOf(data['unavailable']),
    currentStateId: nullableString(data['currentStateId']),
    latched: rawLatched === true || rawLatched === 1,
    armedAt,
    divergedAt: nullableNumber(data['divergedAt']),
    restoredAt: nullableNumber(data['restoredAt']),
    lastCheckedAt: nullableNumber(data['lastCheckedAt']),
    lastConfidence: nullableNumber(data['lastConfidence']),
    currentCondition: nullableString(data['currentCondition']),
    updatedAt,
  }
}

const UNAVAILABLE_VALUES: readonly SceneUnavailable[] = [
  'no-reference-for-condition',
  'view-shifted',
  'no-vision-profile',
  'encoder-model-changed',
  'no-snapshot',
]

function unavailableOf(value: unknown): SceneUnavailable | null {
  if (typeof value !== 'string') return null
  return UNAVAILABLE_VALUES.find((v) => v === value) ?? null
}
