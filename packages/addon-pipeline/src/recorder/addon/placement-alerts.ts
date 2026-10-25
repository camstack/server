/**
 * The recorder's storage alerts, as ONE row per (location, reason) episode.
 *
 * The alert centre dedups on the alert `id` (a re-emit of the same id updates
 * the row) and `metadata.episodeKey` is the episode identity downstream
 * notification rules dedupe on. The recorder used to
 * mint `randomUUID()` per emit, so a location that stayed unusable produced a
 * new row every pass — 164 active rows in a few hours, and no
 * critical signal for the operator-notification rules to act on.
 *
 * Severity follows what the operator must do:
 *   - `unusable`      critical: the volume under a location is not the one it
 *                     last wrote to; recordings on it stop or are misplaced.
 *   - `shared-root`   error: two writable locations share one disk (config).
 *   - `writer-restart` warning: a planned move waits for a camera to re-attach.
 */
import type { Alert, AlertSeverity, IScopedLogger, LogExtras } from '@camstack/types'
import type { PendingWriterMove } from './pending-writer-moves.js'
import { errMsg } from '@camstack/types'

export type PlacementAlertReason = 'unusable' | 'shared-root' | 'writer-restart'

/** What a placement fault carries to the alert surface (best-effort). */
export interface PlacementAlert {
  readonly locationId: string
  readonly reason: PlacementAlertReason
  readonly detail: string
}

export interface PlacementAlertsPort {
  readonly emit: (alert: Alert) => Promise<void>
  readonly update: (input: {
    readonly alertId: string
    readonly patch: Partial<Alert>
  }) => Promise<void>
}

export interface PlacementAlertPublisherDeps {
  readonly port: PlacementAlertsPort
  readonly logger: IScopedLogger
  /** Addon id recorded as the alert source. */
  readonly sourceId: string
  readonly nodeId: string
  readonly now: () => number
}

interface Episode {
  readonly createdAt: number
  count: number
}

const SEVERITY: Readonly<Record<PlacementAlertReason, AlertSeverity>> = {
  unusable: 'critical',
  'shared-root': 'error',
  'writer-restart': 'warning',
}

const TITLE: Readonly<Record<PlacementAlertReason, string>> = {
  unusable: 'Recordings storage location unusable',
  'shared-root': 'Recordings storage locations share one disk',
  'writer-restart': 'Recording placement waiting on a writer restart',
}

/** Stable identity of one fault: the alert id AND its episode key. */
export function placementAlertId(locationId: string, reason: PlacementAlertReason): string {
  return `recorder-placement:${locationId}:${reason}`
}

export class PlacementAlertPublisher {
  private readonly episodes = new Map<string, Episode>()

  constructor(private readonly deps: PlacementAlertPublisherDeps) {}

  /** Raise (or refresh) the alert of one fault. Advisory: never throws. */
  raise(input: PlacementAlert): void {
    const id = placementAlertId(input.locationId, input.reason)
    const now = this.deps.now()
    const prior = this.episodes.get(id)
    const episode: Episode = prior ?? { createdAt: now, count: 0 }
    episode.count += 1
    this.episodes.set(id, episode)

    const alert: Alert = {
      id,
      category: 'storage',
      severity: SEVERITY[input.reason],
      title: TITLE[input.reason],
      message: input.detail,
      status: 'active',
      read: false,
      createdAt: episode.createdAt,
      updatedAt: now,
      source: { type: 'addon', id: this.deps.sourceId },
      metadata: {
        locationId: input.locationId,
        nodeId: this.deps.nodeId,
        reason: input.reason,
        episodeKey: id,
        count: episode.count,
      },
    }
    void this.deps.port.emit(alert).catch((err: unknown) => {
      this.deps.logger.warn('recorder: storage alert emit failed (advisory)', {
        meta: { locationId: input.locationId, reason: input.reason, error: errMsg(err) },
      })
    })
  }

  /** The fault is gone: close its alert. A fault that never fired is a no-op. */
  resolve(locationId: string, reason: PlacementAlertReason): void {
    const id = placementAlertId(locationId, reason)
    const episode = this.episodes.get(id)
    if (episode === undefined) return
    this.episodes.delete(id)
    this.deps.logger.info('recorder: storage fault recovered — closing its alert', {
      meta: { locationId, reason, alertId: id, raisedTimes: episode.count },
    })
    void this.deps.port
      .update({
        alertId: id,
        patch: { status: 'completed', read: true, updatedAt: this.deps.now() },
      })
      .catch((err: unknown) => {
        this.deps.logger.warn('recorder: closing a recovered storage alert failed (advisory)', {
          meta: { locationId, reason, alertId: id, error: errMsg(err) },
        })
      })
  }
}

/**
 * Keeps the `writer-restart` alerts true to the live set of pending writer
 * moves: one alert per PLANNED location, raised while any camera is still
 * pending for it, completed when none is (the move landed, or the plan was
 * dropped - the target was drained or deleted).
 */
export class WriterRestartAlerts {
  private previous: readonly PendingWriterMove[] = []

  constructor(
    private readonly publisher: PlacementAlertPublisher,
    private readonly logger: { info(message: string, extras?: LogExtras): void },
  ) {}

  update(moves: readonly PendingWriterMove[]): void {
    const byLocation = new Map<string, number>()
    for (const move of moves) {
      byLocation.set(move.plannedFor, (byLocation.get(move.plannedFor) ?? 0) + 1)
    }
    for (const [locationId, count] of byLocation) {
      this.publisher.raise({
        locationId,
        reason: 'writer-restart',
        detail:
          `${String(count)} recording profile(s) are planned for ${locationId} ` +
          'and will keep writing to their current location until each camera next attaches. ' +
          'Continuously-recording cameras never re-attach on their own.',
      })
    }
    const stillPending = new Set(
      moves.map((m) => `${String(m.deviceId)}:${m.profile}>${m.plannedFor}`),
    )
    for (const gone of this.previous) {
      if (stillPending.has(`${String(gone.deviceId)}:${gone.profile}>${gone.plannedFor}`)) continue
      this.logger.info('recorder placement: writer-restart no longer pending for this camera', {
        tags: { deviceId: gone.deviceId },
        meta: { locationId: gone.plannedFor, profile: gone.profile, writingTo: gone.writingTo },
      })
    }
    for (const gone of this.previous) {
      if (!byLocation.has(gone.plannedFor))
        this.publisher.resolve(gone.plannedFor, 'writer-restart')
    }
    this.previous = moves
  }
}
