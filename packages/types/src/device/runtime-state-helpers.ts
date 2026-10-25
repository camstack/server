import type { z } from 'zod'
import type { CapabilityDefinition } from '../capabilities/capability-definition.js'
import type { IDeviceRuntimeState } from './device-runtime-state.js'

const LAST_FETCHED_FIELD = 'lastFetchedAt'

/**
 * How long a bridge stops re-attempting a refresh that did not land.
 *
 * Sized against the failure it exists for: a camera whose control plane
 * is unreachable costs the FULL connect give-up (~3s on Linux when the
 * neighbour never answers, up to the client's own timeout otherwise) on
 * every attempt, and a failed refresh never advances `lastFetchedAt`, so
 * without a cooldown the slice is permanently stale and EVERY read pays
 * that price. One attempt per minute is enough to notice the camera
 * coming back; per-read is enough to stall the viewer's first paint.
 */
export const RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS = 60_000

/**
 * The freshness window for a cap whose value changes ONLY when WE write it.
 *
 * The usual `staleMs: 10_000` is tuned for a reading that moves on its own — a
 * battery level, a day/night state that flips at dusk. It is the wrong number
 * for a cap like `privacy-mask`, whose two facts (is the video mask on, is the
 * microphone on) change when an operator changes them, through a `setMask` /
 * `setAudioEnabled` that **re-reads the camera and rewrites this very slice**.
 * A write is therefore its own invalidation: the window never delays an
 * operator's own change, however long it is.
 *
 * What the window really bounds is the ONE case we do not write: somebody
 * changing the mask in the vendor app or the camera's web UI. Ten minutes is
 * the trade — that change is visible within ten minutes, and a fleet of 29
 * cameras behind a page that polls every 5s costs about 3 camera round trips a
 * minute instead of 696
 * ([D221](../../../../docs/decisions/adr-0221-a-polled-list-never-dials-a-camera.md)).
 *
 * Use it ONLY with {@link RuntimeStateStaleReadPolicy} `'serve-and-revalidate'`.
 * On the awaiting default a window this long does not remove the stall, it
 * merely makes it rarer and just as long.
 */
export const OPERATOR_WRITTEN_STALE_MS = 10 * 60_000

/**
 * What a read does when the slice it finds is STALE **and present**.
 *
 *  - `'await-refresh'` (default) — the caller waits for the camera. Right for a
 *    reader that asked BECAUSE it wants the current value: an open settings
 *    form, a write path reading back what the firmware accepted.
 *  - `'serve-and-revalidate'` — the caller is answered from the slice
 *    immediately and the refresh runs behind it, for the next caller. Right for
 *    a POLLED reader, which by definition will ask again shortly and must never
 *    put a camera round trip on a request path (D49, D221).
 *
 * A COLD slice — one that was never fetched — awaits under both policies. The
 * first render has to be a real answer rather than a flash of the `empty()`
 * default, and a default is exactly what "the operator muted this" looks like.
 */
export type RuntimeStateStaleReadPolicy = 'await-refresh' | 'serve-and-revalidate'

/**
 * Minimal logger surface the bridge uses. Declared with METHOD syntax
 * (not a property arrow) so the parameter check is bivariant — a scoped
 * logger whose `warn` takes a structured `LogExtras` second argument
 * satisfies this without the caller importing the logger types.
 */
export interface RuntimeStateBridgeExtras {
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

export interface RuntimeStateBridgeLogger {
  warn(message: string, extras?: RuntimeStateBridgeExtras): void
  info(message: string, extras?: RuntimeStateBridgeExtras): void
}

/**
 * Bridge a cap's `runtimeState` slice to its read-side methods.
 *
 * Pattern: provider keeps the camera fetch / write path, but delegates
 * stale-check + slice read + cold-start fallback to this helper. Cuts
 * the boilerplate that every provider would otherwise repeat across
 * `getStatus`, `getSettings`, and any other read-side cap method.
 *
 * Convention: the cap's `runtimeState` schema must include a numeric
 * `lastFetchedAt` field (ms epoch) so the helper can drive the
 * stale-check. The field is stripped from the value returned by
 * `getStatus` so the cap's status schema (which doesn't carry it)
 * still parses cleanly.
 *
 * Usage in a provider:
 * ```ts
 * const bridge = createRuntimeStateBridge({
 *   runtimeState: this.runtimeState,
 *   cap: ptzAutotrackCapability,
 *   ownDeviceId: this.id,
 *   refresh: () => this.refreshAutotrackFromCamera(),
 *   staleMs: 10_000,
 *   empty: () => emptyAutotrackStatus(),
 * })
 *
 * const provider: InferNativeProvider<typeof ptzAutotrackCapability> = {
 *   getStatus: bridge.getStatus,
 *   getSettings: async ({ deviceId }) => {
 *     if (deviceId !== this.id) return null
 *     await bridge.ensureFresh()
 *     return this.runtimeState.getCapState<...>(...)?.currentSettings ?? null
 *   },
 *   setEnabled: async (...) => { ... ; await this.refreshAutotrackFromCamera() },
 *   setSettings: async (...) => { ... ; await this.refreshAutotrackFromCamera() },
 * }
 * ```
 *
 * Single-flight (collapsing concurrent `refresh()` invocations) lives
 * INSIDE `refresh` — the camera client owns its own promise slot. This
 * helper stays thin so a single provider can host multiple cap-bridged
 * readers without fighting over a shared promise.
 *
 * ## The freshness window belongs to the READER, not to the cap
 *
 * `staleMs` plus {@link RuntimeStateStaleReadPolicy} are what make this the
 * ONLY cache in front of a cap. Before D221 they were not: `privacy-mask` kept
 * the 10s window meant for a self-changing reading while a fleet-wide list
 * polled it every 5s, so the slice was stale on nearly every read and the badge
 * dialled 29 cameras twelve times a minute. The answer was a SECOND cache in
 * the consumer — two authorities over one fact, and the write path that did not
 * route through that consumer (the mask editor, which writes the cap directly)
 * left it lying.
 *
 * So a cap whose value only an operator changes takes
 * {@link OPERATOR_WRITTEN_STALE_MS} and `'serve-and-revalidate'`, here, once:
 * the write path already re-reads the camera into this slice, which is a
 * stronger invalidation than any downstream mirror can offer, and no consumer
 * needs a cache of its own.
 *
 * ## A refresh that does not LAND is a miss, and a miss costs the caller
 *
 * Providers swallow their own camera errors (they keep the last slice
 * rather than failing a read), so `refresh()` resolving proves nothing.
 * The bridge gates on what it can verify: did `lastFetchedAt` advance.
 * If it did not, the slice is still stale, so the very next read would
 * call `refresh()` again — and on an unreachable camera each of those
 * calls burns the full connect give-up. Measured on the live hub:
 * `privacyMask.getStatus` for a camera whose IP stopped answering took
 * 3.27s EVERY call (vs 0.20s for a reachable one), and that latency was
 * inherited by the per-camera status aggregation the viewer runs on
 * first paint.
 *
 * So a miss opens a cooldown ({@link RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS}):
 * reads inside it answer immediately from the last (possibly `empty()`)
 * slice with no camera I/O. The answer is unchanged — only the wait is
 * gone. And the miss is LOGGED with `tags.deviceId`: a read that quietly
 * returns defaults forever is exactly the silence that makes a dead
 * camera look like a working one.
 */
export interface RuntimeStateBridge<TStatus> {
  /** Run a stale-check; if the slice is missing or older than
   *  `staleMs`, refresh it — awaiting the camera, or behind the caller
   *  when `staleRead` is `'serve-and-revalidate'` and a slice already
   *  exists. Idempotent within the freshness window — back-to-back calls
   *  touch zero camera I/O. */
  readonly ensureFresh: () => Promise<void>
  /** Drop-in `getStatus` provider method. Includes the cross-device
   *  guard + freshness check + status projection from the slice. */
  readonly getStatus: (input: { readonly deviceId: number }) => Promise<TStatus>
}

export function createRuntimeStateBridge<
  TCap extends CapabilityDefinition & { status: { schema: z.ZodType } },
>(params: {
  readonly runtimeState: IDeviceRuntimeState
  readonly cap: TCap
  readonly ownDeviceId: number
  readonly refresh: () => Promise<void>
  readonly staleMs: number
  readonly empty: () => z.infer<TCap['status']['schema']>
  /** Override the miss cooldown (tests, or a cap whose fetch is cheap). */
  readonly refreshMissCooldownMs?: number
  /** What a stale-but-present slice does. Defaults to `'await-refresh'`,
   *  which is what every caller did before the policy existed. */
  readonly staleRead?: RuntimeStateStaleReadPolicy
  /** Scoped logger so a refresh that never lands is visible per-device. */
  readonly logger?: RuntimeStateBridgeLogger
}): RuntimeStateBridge<z.infer<TCap['status']['schema']>> {
  const { runtimeState, cap, ownDeviceId, refresh, staleMs, empty, logger } = params
  const missCooldownMs = params.refreshMissCooldownMs ?? RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS
  const staleRead: RuntimeStateStaleReadPolicy = params.staleRead ?? 'await-refresh'

  /** Epoch ms until which a refresh is not re-attempted. 0 = no cooldown. */
  let missCooldownUntil = 0

  /**
   * The refresh this bridge currently has in the air, if any.
   *
   * Providers single-flight their own camera client, so this is not what stops
   * a second round trip. What it stops is a POLLED reader JOINING one: under
   * `'serve-and-revalidate'` a read that finds a refresh already outstanding is
   * answered from the slice at once — even a cold, empty slice, which reports
   * UNKNOWN, which is the truth about a camera nobody has reached.
   *
   * That distinction is the whole cost of an unreachable camera. Measured on
   * the live hub (device 3629, an offline battery Reolink): its refresh takes
   * 23.1s to give up, so without this every 5s poll landing inside those 23s
   * joined the wait and spent the caller's full 1.2s source budget — five
   * stalled polls per cooldown cycle, for one camera, forever.
   */
  let refreshInFlight: Promise<void> | null = null

  const readFetchedAt = (): number => {
    const slice = runtimeState.getCapState<Record<string, unknown>>(cap.name)
    const value = slice?.[LAST_FETCHED_FIELD]
    return typeof value === 'number' ? value : 0
  }

  /**
   * Stop re-reading this camera for `missCooldownMs`, and say so. The
   * warn is the ONLY line an operator gets for a cap that has silently
   * been answering with defaults, so it names the cap and carries
   * `tags.deviceId` — a miss is always asked per-camera.
   */
  const openMissCooldown = (err: unknown): void => {
    missCooldownUntil = Date.now() + missCooldownMs
    logger?.warn(
      `${cap.name}: refresh did not land — serving the last slice and not re-reading the camera for ${String(missCooldownMs)}ms`,
      {
        tags: { deviceId: ownDeviceId },
        meta: {
          cooldownMs: missCooldownMs,
          error: err === undefined ? null : err instanceof Error ? err.message : String(err),
        },
      },
    )
  }

  /**
   * One refresh attempt, plus the LANDED check that decides the cooldown.
   *
   * @param fetchedAt What `lastFetchedAt` was before the attempt — the only
   *                  evidence the bridge has that the refresh persisted
   *                  anything, since providers swallow their own camera errors.
   */
  const runRefresh = async (fetchedAt: number): Promise<void> => {
    try {
      await refresh()
    } catch (err) {
      // A provider that lets its camera error out (rather than swallowing
      // it) is the same miss, and the caller still paid for it. Open the
      // cooldown BEFORE rethrowing so the next read is free — the error
      // itself stays the caller's to handle.
      openMissCooldown(err)
      throw err
    }

    if (readFetchedAt() > fetchedAt) {
      if (missCooldownUntil !== 0) {
        missCooldownUntil = 0
        logger?.info(`${cap.name}: refresh landed again — resuming normal polling`, {
          tags: { deviceId: ownDeviceId },
        })
      }
      return
    }

    // The refresh resolved without persisting anything: the provider
    // swallowed a camera error. Say so, and stop paying for it.
    openMissCooldown(undefined)
  }

  /**
   * Start a refresh and remember it, at most one at a time.
   *
   * It never rejects: under `'serve-and-revalidate'` the caller is answered
   * from the slice either way, so a floating rejection would take the process
   * down for a fault the miss cooldown has already recorded and logged.
   */
  const startRefresh = (fetchedAt: number): Promise<void> => {
    const existing = refreshInFlight
    if (existing !== null) return existing
    const started = runRefresh(fetchedAt)
      .catch((): void => undefined)
      .finally(() => {
        refreshInFlight = null
      })
    refreshInFlight = started
    return started
  }

  const ensureFresh = async (): Promise<void> => {
    const slice = runtimeState.getCapState<Record<string, unknown>>(cap.name)
    const fetchedAt = readFetchedAt()
    if (slice && Date.now() - fetchedAt <= staleMs) {
      // A fresh slice means the camera answered someone (a write path
      // calls `refresh()` directly), so any cooldown is stale evidence.
      missCooldownUntil = 0
      return
    }
    // Stale — but a refresh that already failed inside the cooldown must
    // not be paid for again. Answer from the slice we have.
    if (Date.now() < missCooldownUntil) return

    if (staleRead === 'serve-and-revalidate') {
      // A refresh is already in the air: answer from the slice NOW, whatever
      // its age — including a cold, empty one, which reports UNKNOWN. Joining
      // the wait is what turns one unreachable camera into a stall on every
      // poll it overlaps.
      if (refreshInFlight !== null) return
      // Stale but present: refresh behind the caller, for the next one.
      if (slice && fetchedAt > 0) {
        void startRefresh(fetchedAt)
        return
      }
      // Cold, and nothing in the air: THIS caller pays for it, so the first
      // render is a real answer rather than a flash of the `empty()` default.
      await startRefresh(fetchedAt)
      return
    }

    await runRefresh(fetchedAt)
  }

  const projectStatus = (): z.infer<TCap['status']['schema']> => {
    const slice = runtimeState.getCapState<Record<string, unknown>>(cap.name)
    if (!slice) return empty()
    // Strip lastFetchedAt (and any future helper-only fields) before
    // returning. Status schemas don't carry this field; runtime-state
    // schemas extend status with it for stale tracking.
    const { [LAST_FETCHED_FIELD]: _omit, ...rest } = slice
    return rest as z.infer<TCap['status']['schema']>
  }

  const getStatus = async ({
    deviceId,
  }: {
    readonly deviceId: number
  }): Promise<z.infer<TCap['status']['schema']>> => {
    if (deviceId !== ownDeviceId) {
      throw new Error(`${cap.name}: deviceId mismatch, expected ${ownDeviceId}, got ${deviceId}`)
    }
    await ensureFresh()
    return projectStatus()
  }

  return { ensureFresh, getStatus }
}
