/**
 * Record-kind and collection declarations. Moved out of
 * `pipeline-analytics/index.ts` verbatim (Plan B, boot extraction): only the
 * visibility of the entry point changed. Every dependency is read through the
 * deps object.
 */

import type { AddonContext, RecordsAccess, SettingsStoreClient } from '@camstack/types'
import { ncDurableRecordKinds } from '../../notification-center/nc-durable-record-kinds.js'
import { ncRecordKinds } from '../../notification-center/record-kinds.js'
import { declarePipelineAnalyticsBootCollections } from '../pa-boot-declare.js'
import { pipelineAnalyticsRecordKinds } from '../record-kinds.js'
import { runAudioTrackClassMigration } from '../store/audio-track-class-migration.js'
import { OBJECT_EVENTS_COLLECTION } from '../store/event-store.js'
import { FaceRescoreStateStore } from '../store/face-rescore-state-store.js'
import { runLabelTierMigration } from '../store/label-tier-migration.js'
import { MigrationMarkerStore } from '../store/migration-marker-store.js'
import { SweepCursorStore } from '../store/sweep-cursor-store.js'
import { TRACKS_COLLECTION } from '../store/track-store.js'
import type { AnalyticsApi } from './boot-types.js'

export interface DeclareCollectionsDeps {
  readonly settingsStore: () => SettingsStoreClient | null
  readonly setSettingsStore: (value: SettingsStoreClient | null) => void
  readonly localOwnNodeId: () => string
  readonly requireRecords: () => RecordsAccess
  readonly faceRescoreState: () => FaceRescoreStateStore | null
  readonly setFaceRescoreState: (value: FaceRescoreStateStore | null) => void
  readonly ctx: () => AddonContext<Record<string, unknown>>
  readonly sweepCursors: () => SweepCursorStore | null
  readonly setSweepCursors: (value: SweepCursorStore | null) => void
}

export class DeclareCollections {
  constructor(protected readonly deps: DeclareCollectionsDeps) {}

  protected get settingsStore(): SettingsStoreClient | null {
    return this.deps.settingsStore()
  }

  protected set settingsStore(value: SettingsStoreClient | null) {
    this.deps.setSettingsStore(value)
  }

  protected localOwnNodeId(): string {
    return this.deps.localOwnNodeId()
  }

  protected requireRecords(): RecordsAccess {
    return this.deps.requireRecords()
  }

  protected get faceRescoreState(): FaceRescoreStateStore | null {
    return this.deps.faceRescoreState()
  }

  protected set faceRescoreState(value: FaceRescoreStateStore | null) {
    this.deps.setFaceRescoreState(value)
  }

  protected get ctx(): AddonContext<Record<string, unknown>> {
    return this.deps.ctx()
  }

  protected get sweepCursors(): SweepCursorStore | null {
    return this.deps.sweepCursors()
  }

  protected set sweepCursors(value: SweepCursorStore | null) {
    this.deps.setSweepCursors(value)
  }

  async declareCollections(api: AnalyticsApi): Promise<void> {
    // Held for the orphan audit, which pages a collection by NAME (the scope
    // list is derived from the classification, not from a store instance).
    this.settingsStore = api.settingsStore
    // Record kinds (D881) are DECLARED by the hub only — same split as addon-ai:
    // declaring from an agent crashed pipeline-analytics on every non-hub node
    // after the phase-2 deploy. Every node USES them (an agent's `ctx.records`
    // reaches the hub's engine), so no role declares a legacy table either.
    const isHub = this.localOwnNodeId() === 'hub'
    let markers: MigrationMarkerStore | null = null
    if (isHub) {
      const records = this.requireRecords()
      // Declared FIRST and not in the parallel batch: a refused declaration
      // must stop the boot before any other declare races it.
      await records.declare(pipelineAnalyticsRecordKinds)
      await records.declare(ncRecordKinds)
      await records.declare(ncDurableRecordKinds)
      markers = MigrationMarkerStore.of(records)
      this.faceRescoreState = FaceRescoreStateStore.of(
        records,
        this.ctx.logger.child('FaceRescoreState'),
      )
      this.sweepCursors = SweepCursorStore.of(records, this.ctx.logger.child('SweepCursors'))
    }
    // The same three tables on every role; every other table is a records kind.
    await declarePipelineAnalyticsBootCollections(api.settingsStore)

    if (markers === null) return

    // 4g: move pre-tier `label` values into the tiered slots. AFTER every
    // declare — the columns it writes only exist once `declareCollection` has
    // run, and on a hub-main that predates the 2026-08-08 `ensureTable`
    // fingerprint fix they do NOT exist even then (the memo was keyed by table
    // NAME, so a redeployed addon's new column never reached SQLite). Writing a
    // column the table lacks does not error; it is silently dropped. Sequence
    // and verification: `docs/architecture/post-analysis.md`.
    //
    // FLOATING, not awaited: the pass pages up to 200 000 rows per collection
    // over the UDS store client and rewrites the unmigrated ones ONE BY ONE —
    // on a fleet-scale tracks table that is minutes of serial round-trips, and
    // it once owned the whole 5-minute silent boot window's prime suspect slot
    // (2026-08-15). Nothing downstream of init reads its result: unmigrated
    // rows still display (`subLabel ?? label`), the row decision is idempotent,
    // and the completion marker only gates a re-scan. It still runs at every
    // boot — just off the readiness path.
    void runLabelTierMigration(
      {
        store: api.settingsStore,
        markers,
        logger: this.ctx.logger,
        now: () => Date.now(),
      },
      [TRACKS_COLLECTION, OBJECT_EVENTS_COLLECTION],
    ).catch((err: unknown) => {
      this.ctx.logger.warn('label tier migration failed — will retry next boot', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })

    // D189: the same shape, and FLOATING for the same reasons — nothing
    // downstream of init reads its result, because `rowToTrack` already applies
    // the contract on read. This pass exists to converge the DISK so that
    // read-side compat can be deleted; when it reports `rewritten: 0` on a
    // fleet boot, `normalizeAudioTrackClass` in `rowToTrack` is dead code.
    void runAudioTrackClassMigration(
      {
        store: api.settingsStore,
        markers,
        logger: this.ctx.logger,
        now: () => Date.now(),
      },
      TRACKS_COLLECTION,
    ).catch((err: unknown) => {
      this.ctx.logger.warn('audio track class migration failed — will retry next boot', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
  }
}
