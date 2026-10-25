/**
 * Wake-on-play — pressing play on a sleeping battery camera wakes it, and the
 * error you get when it does not names the real state (D173).
 *
 * ## What this replaces
 *
 * `webrtcSession.handleOffer` resolved a brokerId, found nothing registered
 * for it, and threw `No broker for stream <id>`. On a mains camera that
 * sentence is true and useful: something is misconfigured. On a battery
 * camera it was neither — the camera was healthy, asleep, and one Baichuan
 * wake away from streaming. Nothing on the live path had ever called
 * `battery.wakeForStream`; its only caller in the whole repo was the Alexa
 * addon, so the viewer's own play button was the one surface that could not
 * wake a camera.
 *
 * ## The shape
 *
 * A wake is DEMAND. It is the operator asking for the camera, so it bypasses
 * every proactive-wake cooldown — the contract forbids us waking a battery cam
 * on our own initiative, and says nothing about waking it because somebody
 * pressed play. That asymmetry is the whole design: brokers stay AVAILABLE
 * (definable, from the durable catalog) without being ACTIVE, and the dial is
 * the only thing that touches the camera. Concurrent/retried requests for the
 * same waking device share one transaction; a client retry must not become a
 * second physical wake.
 *
 * ## Honest states
 *
 * The three outcomes are three different sentences, and a client must be able
 * to tell them apart:
 *
 *  - `sleeping` — we asked, the firmware did not answer inside the bound. Try
 *    again; the camera is probably fine.
 *  - `waking` — the firmware acknowledged the wake but no stream had appeared
 *    by the time we gave up. The broker's own `'waking'` placeholder reason
 *    covers this window on surfaces that render one.
 *  - `unreachable` — passive evidence says nothing has been heard from this
 *    camera for hours (see `deriveBatteryPresence`). We do NOT spend a wake on
 *    it: this is a fault, and dialling it would only add a timeout to it.
 *
 * A flat "No broker for stream" is none of those, and it is the one thing this
 * module must never produce for a battery camera.
 */

import { deriveBatteryPresence, type BatteryPresence, type IScopedLogger } from '@camstack/types'

/**
 * Why a battery camera's stream could not be produced. Carries the resolved
 * presence so a caller — or a client reading the error text — can tell a
 * normal sleeper from a dead one.
 */
export class BatteryStreamUnavailableError extends Error {
  readonly presence: BatteryPresence | 'waking'
  readonly deviceId: number

  constructor(deviceId: number, presence: BatteryPresence | 'waking', detail: string) {
    super(`Battery camera ${String(deviceId)} is ${presence}: ${detail}`)
    this.name = 'BatteryStreamUnavailableError'
    this.presence = presence
    this.deviceId = deviceId
  }
}

/** The passive battery facts this decision needs. `null` = no slice at all. */
export interface BatteryFacts {
  readonly sleeping: boolean
  readonly lastContactAt?: number
}

export interface WakeOnPlayDeps {
  readonly logger: IScopedLogger
  /**
   * Does this device carry `DeviceFeature.BatteryOperated`? Read from the
   * DEVICE registry, never from published cam-streams — the whole reason we
   * are here is that there are none.
   *
   * `null` means the question could not be answered. Unknown never triggers a
   * wake and never triggers a fault: we fall through to the pre-existing
   * error path unchanged (D49 — unknown excludes nothing).
   */
  readonly isBatteryDevice: (deviceId: number) => Promise<boolean | null>
  /** The device's `battery` slice, or `null` when absent/unreadable. */
  readonly readBatteryFacts: (deviceId: number) => Promise<BatteryFacts | null>
  /** `battery.wakeForStream`. Resolves `awoke:false` on timeout, never throws. */
  readonly wakeForStream: (
    deviceId: number,
    timeoutMs: number,
  ) => Promise<{ awoke: boolean; durationMs: number }>
  /** Pull `stream-catalog` and (re)publish this device's cam-streams. */
  readonly reconcileCatalog: (deviceId: number) => Promise<void>
  /** Re-run the normal broker resolution for this brokerId. */
  readonly ensureBroker: () => Promise<void>
  /** Is a broker registered for the target brokerId right now? */
  readonly hasBroker: () => boolean
  readonly nowMs?: () => number
  readonly wait?: (timeoutMs: number) => Promise<void>
}

/** Bound on the firmware wake. Matches the cap's own sensible range. */
export const WAKE_FOR_STREAM_TIMEOUT_MS = 8_000
/**
 * Bound AFTER firmware acknowledgement for the provider to rebuild/publish
 * stream parameters and the broker to observe them. Field cameras can
 * acknowledge several seconds before their media/catalog plane is usable.
 */
export const BROKER_SETTLE_TIMEOUT_MS = 20_000
/** Reconcile cadence while the acknowledged camera finishes waking. */
export const BROKER_SETTLE_POLL_INTERVAL_MS = 1_500

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })
}

/**
 * Device-scoped single-flight for wake-on-play. A wake applies to the whole
 * camera, not one profile/brokerId, so concurrent profile requests and client
 * retries all await the same bounded transaction.
 */
export class BatteryWakeOnPlaySingleFlight {
  private readonly inFlight = new Map<number, Promise<void>>()

  async run(deviceId: number, deps: WakeOnPlayDeps): Promise<void> {
    const existing = this.inFlight.get(deviceId)
    if (existing) {
      await existing
      // The shared wake is device-wide, but this caller may target a
      // different profile/brokerId. The catalog is settled now; resolve that
      // caller's broker without issuing another physical wake.
      if (!deps.hasBroker()) {
        await deps.ensureBroker().catch((err: unknown) => {
          deps.logger.debug('wake-on-play: joined demand broker retry failed', {
            tags: { deviceId },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
      }
      if (!deps.hasBroker()) {
        throw new BatteryStreamUnavailableError(
          deviceId,
          'waking',
          'the shared wake completed but this stream profile is not available yet — try again',
        )
      }
      return
    }

    const transaction = wakeBatteryDeviceForPlay(deviceId, deps)
    this.inFlight.set(deviceId, transaction)
    try {
      await transaction
    } finally {
      if (this.inFlight.get(deviceId) === transaction) {
        this.inFlight.delete(deviceId)
      }
    }
  }
}

/**
 * Make a broker available for a battery camera that has none, by asking the
 * camera to wake.
 *
 * Returns normally when a broker exists (either it already did, or the wake
 * produced one, or the device is not battery-operated and the caller's
 * pre-existing error path should run). Throws
 * {@link BatteryStreamUnavailableError} only for a battery camera we could not
 * produce a stream for — with the reason named.
 *
 * After an acknowledged wake, repeatedly reconciles the provider catalog and
 * retries broker resolution within one field-sized bound. It never issues a
 * second wake inside that transaction.
 */
export async function wakeBatteryDeviceForPlay(
  deviceId: number,
  deps: WakeOnPlayDeps,
): Promise<void> {
  if (deps.hasBroker()) return

  const isBattery = await deps.isBatteryDevice(deviceId).catch(() => null)
  // Not battery, or we could not tell: leave the caller's existing behaviour
  // byte-identical. Guessing "battery" here would spend a wake call on a
  // mains camera; guessing "not battery" is what we already do today.
  if (isBattery !== true) return

  const facts = await deps.readBatteryFacts(deviceId).catch(() => null)
  const observedAt = (deps.nowMs ?? Date.now)()
  const presence = deriveBatteryPresence({ status: facts, nowMs: observedAt })

  if (presence === 'unreachable') {
    // Do not dial. Nothing passive has arrived for hours — a wake would add a
    // timeout to a fault, and the honest answer is available now.
    deps.logger.warn('wake-on-play refused — battery camera is unreachable, not asleep', {
      tags: { deviceId },
      meta: {
        lastContactAt: facts?.lastContactAt ?? 0,
        silenceMs: observedAt - (facts?.lastContactAt ?? 0),
      },
    })
    throw new BatteryStreamUnavailableError(
      deviceId,
      'unreachable',
      'nothing has been heard from it for hours — check the battery or its network',
    )
  }

  deps.logger.info('wake-on-play — no broker for a sleeping battery camera, requesting a wake', {
    tags: { deviceId },
    meta: { presence, timeoutMs: WAKE_FOR_STREAM_TIMEOUT_MS },
  })

  const wake = await deps
    .wakeForStream(deviceId, WAKE_FOR_STREAM_TIMEOUT_MS)
    .catch((): { awoke: boolean; durationMs: number } => ({ awoke: false, durationMs: 0 }))

  // StreamParamsChanged is a lossy nudge and may fire before wakeForStream
  // returns, so a single event wait + retry can miss the entire publication.
  // Reconcile immediately, then poll throughout the acknowledged wake's
  // settle window. An unacknowledged wake still gets one best-effort pass.
  const nowMs = deps.nowMs ?? Date.now
  const settleStartedAt = nowMs()
  const settleDeadline = settleStartedAt + (wake.awoke ? BROKER_SETTLE_TIMEOUT_MS : 0)
  const maxAttempts = wake.awoke
    ? Math.ceil(BROKER_SETTLE_TIMEOUT_MS / BROKER_SETTLE_POLL_INTERVAL_MS) + 1
    : 1
  let attempts = 0

  while (attempts < maxAttempts) {
    attempts += 1
    await deps.reconcileCatalog(deviceId).catch((err: unknown) => {
      deps.logger.debug('wake-on-play: catalog reconcile failed', {
        tags: { deviceId },
        meta: { attempt: attempts, error: err instanceof Error ? err.message : String(err) },
      })
    })
    await deps.ensureBroker().catch((err: unknown) => {
      deps.logger.debug('wake-on-play: broker retry failed', {
        tags: { deviceId },
        meta: { attempt: attempts, error: err instanceof Error ? err.message : String(err) },
      })
    })

    if (deps.hasBroker()) {
      deps.logger.info('wake-on-play succeeded — broker available after wake', {
        tags: { deviceId },
        meta: {
          awoke: wake.awoke,
          wakeMs: wake.durationMs,
          settleMs: nowMs() - settleStartedAt,
          attempts,
        },
      })
      return
    }

    const remainingMs = settleDeadline - nowMs()
    if (remainingMs <= 0 || attempts >= maxAttempts) break
    await (deps.wait ?? wait)(Math.min(BROKER_SETTLE_POLL_INTERVAL_MS, remainingMs))
  }

  // Still nothing. Name what we actually observed — never "No broker".
  const outcome = wake.awoke ? 'waking' : 'sleeping'
  deps.logger.warn('wake-on-play exhausted — no stream after the wake', {
    tags: { deviceId },
    meta: {
      awoke: wake.awoke,
      wakeMs: wake.durationMs,
      settleMs: nowMs() - settleStartedAt,
      attempts,
      outcome,
    },
  })
  throw new BatteryStreamUnavailableError(
    deviceId,
    outcome,
    wake.awoke
      ? 'it acknowledged the wake but no stream had appeared yet — try again in a few seconds'
      : 'it did not answer the wake in time — try again',
  )
}
