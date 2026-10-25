/**
 * WHERE the teed HomeKit clips are written — resolved through the storage cap,
 * never composed by hand.
 *
 * ## Why a declared location and not the addon's data dir
 *
 * The first cut wrote to `<dataDir>/hksv-clips/`. It worked, and it gave the
 * operator no say: the one thing he asked for after seeing it was to choose the
 * disk. The repo's sanctioned mechanism for that is a declared storage location
 * — `camstack.storageLocations` in `package.json`, aggregated by the kernel,
 * seeded as `<id>:default` by the orchestrator and repointed from the
 * storage-locations surface.
 *
 * ## `homekitClips`, a NEW id, `single`, `local-path`
 *
 * - **New, not `eventMedia`**: a teed clip has no track, no detection and no
 *   event behind it, so it is not event media and the post-analysis retention
 *   sweep must never own its lifetime. Not `recordings` either — those rows are
 *   the recorder's placement planner's, its evictor's and its drain ratchet's,
 *   and our files are not segments its index knows. Not `artifacts`, which is a
 *   SINGLETON shared root whose description enumerates its three tenants:
 *   putting clips there would mean choosing one disk for HomeKit clips, the
 *   notification shelf AND the enrolled gallery together, which is exactly the
 *   choice the operator asked to be able to make separately.
 * - **`single`**: the operator repoints the one instance to pick the disk.
 *   `multi` is deliberately NOT offered — a second location of one class needs a
 *   placement policy, an evictor interplay and a drain ratchet paced to what the
 *   ACTIVE locations of the class grew (D386), and none of that exists here.
 * - **`local-path`**: the tee does real `node:fs` I/O on the directory, so a
 *   remote provider must be REFUSED by declaration rather than discovered when
 *   the first write lands somewhere wrong (the accident `StorageAccess` exists
 *   to end).
 * - **`defaultsTo: 'recordings'`**: a fresh install needs no configuration and
 *   lands on the media volume, exactly as `eventMedia` does.
 *
 * ## The subtree is not optional
 *
 * Because `defaultsTo` makes the seeded default share the recordings root,
 * every write goes under {@link HOMEKIT_CLIPS_SUBTREE}. D327: occupancy of a
 * storage class that shares a disk is the class subtree, never a non-dot entry
 * at the shared root — a drained location once looked full because high footage
 * was writing next to it.
 *
 * ## One state, one interpreter, and a refusal that is not silence
 *
 * The mode is asked of `mayWriteToLocation` and of nothing else (D385/D388 —
 * `storage-location-mode.ts` is the only module allowed to read
 * `config.readOnly` or compare `enabled`). `readonly`, `drain` and `disabled`
 * all resolve to "no root", which the tee treats exactly as it treats a
 * directory it cannot open: no clip, a named warn, and a HomeKit recording that
 * proceeds untouched.
 *
 * The answer is mirrored in memory and refreshed off the event path
 * (`EventCategory.StorageLocationsChanged` is a doorbell — the payload is never
 * the authority, the re-read is), with a revalidation window so a missed
 * doorbell self-heals. A read that fails changes nothing that is already known
 * (D49) — it just refuses this clip.
 */
import type { IScopedLogger, StorageLocationMode } from '@camstack/types'
import { mayWriteToLocation, resolveLocationMode } from '@camstack/types'

/** The declared id. Deployment-wide; see the docblock for why it is new. */
export const HOMEKIT_CLIPS_LOCATION_TYPE = 'homekitClips'

/** The class subtree under the resolved root. Never written at the root (D327). */
export const HOMEKIT_CLIPS_SUBTREE = 'homekit-clips'

/**
 * How long a resolved root is believed without re-asking. Short enough that an
 * operator repointing the location sees it take effect without restarting the
 * addon even if the doorbell is missed, long enough that it is not a cap call
 * per clip.
 */
export const CLIP_LOCATION_REVALIDATE_MS = 60_000

/** Why there is no root right now. Named, because each one is a different fix. */
export type ClipLocationRefusal =
  /** No location of this type exists — the declaration has not been seeded. */
  | 'no-location'
  /** It exists and is `readonly`, `drain` or `disabled` (D385). */
  | 'not-writable'
  /** The storage cap could not be reached, or refused to resolve a path. */
  | 'unreachable'

/**
 * The shape this module needs off a location row — structurally, so a cap
 * answer and a test row satisfy it without either importing the other.
 * `mode`/`enabled`/`config` are passed WHOLE to `resolveLocationMode`; nothing
 * here interprets them.
 */
export interface ClipLocationRow {
  readonly id: string
  readonly type: string
  readonly mode?: StorageLocationMode
  readonly enabled?: boolean
  readonly config: Readonly<Record<string, unknown>>
}

export interface ClipLocationPorts {
  listLocations(): Promise<readonly ClipLocationRow[]>
  resolvePath(locationId: string): Promise<string>
}

/**
 * The slice of `ctx.api` this needs. Structural rather than the generated
 * `AddonApi`, so a test supplies one without the codegen surface.
 */
export interface ClipLocationStorageApi {
  readonly storage: {
    readonly listLocations: {
      query(input: Record<string, never>): Promise<readonly ClipLocationRow[]>
    }
    readonly resolve: {
      query(input: { location: string; relativePath: string }): Promise<string>
    }
  }
}

/**
 * The cap calls, HERE and not in the addon.
 *
 * Deliberately co-located with the `mayWriteToLocation` filter below: a file
 * that enumerates storage locations must visibly decide whether it is choosing
 * a WRITE target (`scripts/check-storage-write-target-enabled.ts` enforces
 * exactly that, and it fired when the closure lived in the addon). Splitting
 * the enumeration from the decision is how the backup fan-out grew a second
 * enabled flag.
 */
export function createClipLocationPorts(api: ClipLocationStorageApi): ClipLocationPorts {
  return {
    listLocations: () => api.storage.listLocations.query({}),
    resolvePath: (locationId) =>
      api.storage.resolve.query({ location: locationId, relativePath: '' }),
  }
}

export interface HksvClipLocationInput {
  readonly logger: IScopedLogger
  readonly ports: ClipLocationPorts
  readonly now?: () => number
  readonly revalidateMs?: number
}

export class HksvClipLocation {
  private readonly log: IScopedLogger
  private readonly now: () => number
  private readonly revalidateMs: number
  private cachedRoot: string | null = null
  private resolvedAt = Number.NEGATIVE_INFINITY
  private refusal: ClipLocationRefusal | null = null
  /** What the last warn said, so a per-clip refusal is not a per-clip log line. */
  private announced: string | null = null
  private inFlight: Promise<string | null> | null = null

  constructor(private readonly input: HksvClipLocationInput) {
    this.log = input.logger
    this.now = input.now ?? Date.now
    this.revalidateMs = input.revalidateMs ?? CLIP_LOCATION_REVALIDATE_MS
  }

  /** Why the last resolution produced no root. `null` once one succeeded. */
  get lastRefusal(): ClipLocationRefusal | null {
    return this.refusal
  }

  /** The doorbell rang (`StorageLocationsChanged`): drop the mirror. */
  invalidate(): void {
    this.resolvedAt = Number.NEGATIVE_INFINITY
  }

  /**
   * The directory clips are written under, or `null` when there is none right
   * now. Never throws: the caller's correct move for every refusal is the same
   * — do not tee this clip, and leave HomeKit alone.
   */
  async root(): Promise<string | null> {
    if (this.now() - this.resolvedAt < this.revalidateMs) return this.cachedRoot
    const inflight = this.inFlight
    // One resolution at a time. Two cameras recording at once would otherwise
    // each spend a cap round trip to learn the same thing.
    if (inflight !== null) return inflight
    const attempt = this.resolve()
    this.inFlight = attempt
    try {
      return await attempt
    } finally {
      this.inFlight = null
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async resolve(): Promise<string | null> {
    try {
      const rows = (await this.input.ports.listLocations()).filter(
        (l) => l.type === HOMEKIT_CLIPS_LOCATION_TYPE,
      )
      if (rows.length === 0) return this.refuse('no-location', {})
      // Declared `single`, so more than one row means something made a second
      // one. Saying nothing would make the disk the clips are NOT on look like
      // the disk they are.
      if (rows.length > 1) {
        this.warnOnce(
          'hksv clip store: more than one HomeKit clips location exists — it is declared single',
          {
            ids: rows.map((l) => l.id),
          },
        )
      }
      const writable = rows.find((l) => mayWriteToLocation(l))
      if (writable === undefined) {
        const first = rows[0]
        return this.refuse('not-writable', {
          locationId: first?.id ?? null,
          // The ONE authority on the state (D385). Reported, never re-derived.
          mode: first === undefined ? null : resolveLocationMode(first),
        })
      }
      const base = await this.input.ports.resolvePath(writable.id)
      const root = `${base.replace(/\/+$/, '')}/${HOMEKIT_CLIPS_SUBTREE}`
      this.cachedRoot = root
      this.resolvedAt = this.now()
      this.refusal = null
      if (this.announced !== null) {
        this.announced = null
        this.log.info('hksv clip store: the clips location is writable again', {
          meta: { locationId: writable.id, root },
        })
      }
      return root
    } catch (err) {
      return this.refuse('unreachable', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private refuse(reason: ClipLocationRefusal, meta: Record<string, unknown>): null {
    this.cachedRoot = null
    this.resolvedAt = this.now()
    this.refusal = reason
    this.warnOnce(
      'hksv clip store: no writable HomeKit clips location — clips are NOT being kept (HomeKit recording is unaffected)',
      { reason, ...meta },
    )
    return null
  }

  /**
   * One line per distinct situation. A refusal that reprinted on every clip
   * would drown the line that says it CHANGED, and the operator reads the log
   * to find out which of the two is happening.
   */
  private warnOnce(message: string, meta: Record<string, unknown>): void {
    const key = `${message}|${JSON.stringify(meta)}`
    if (this.announced === key) return
    this.announced = key
    this.log.warn(message, { meta })
  }
}
