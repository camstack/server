/**
 * Restream tokens whose stored value EXISTS but cannot be read (D870).
 *
 * The broker keeps serving every camera's streams and recording. For a camera
 * whose tokens are held in the keychain and cannot be resolved right now:
 *
 *  - NO restream URL is registered for it (a temporary in-memory token would hand
 *    consumers a URL that dies when the real one is restored), and no token is
 *    written or overwritten; every other camera is unaffected. The alert says
 *    exactly that: its RTSP restream URLs are unavailable - consumers such as
 *    Home Assistant or an NVR get errors - until the keychain is readable.
 *  - The check repeats (on a keychain change and on a timer). When the value
 *    resolves, ONLY that camera's restreamers are registered with the stored
 *    tokens - no broker teardown, no recording gap - and the alert is cleared.
 *  - A secret that is MISSING (deleted, or the keychain restored without it) is
 *    not a block: after TWO consistent `missing` reads (D49) the camera is
 *    released, its restreamers are registered with newly minted tokens that are
 *    PERSISTED at once, the alert says new URLs were issued, and the check stops
 *    for that camera.
 */
import { isSecretMarker, type IScopedLogger, type KeychainResolveResult } from '@camstack/types'
import type { DeviceKeyMirror, RtspTokensOfDevice } from './broker-device-state.js'

export type HeldKind = 'unavailable' | 'missing'

export interface HeldCamera {
  readonly deviceId: number
  readonly ref: string
  readonly kind: HeldKind
  /** The keychain's reason when `unavailable` (`wrong-key`, `key-missing`, ...). */
  readonly reason: string | null
}

/** The keychain handle's resolve, narrowed. */
export interface TokenSecrets {
  resolve(refs: readonly string[]): Promise<KeychainResolveResult>
}

export interface TokenAlerts {
  raise(alert: { deviceId: number; kind: HeldKind; message: string }): Promise<void>
  clear(deviceId: number): Promise<void>
}

/** The timer seam: the real one is `setInterval`; a spec uses fake timers. */
export const HELD_TOKEN_RECHECK_MS = 30_000

export interface TokenRecoveryDeps {
  readonly mirror: Pick<DeviceKeyMirror<RtspTokensOfDevice>, 'load' | 'heldDevices' | 'release'>
  readonly secrets: TokenSecrets
  readonly alerts: TokenAlerts
  readonly logger: IScopedLogger
  /**
   * The cameras that may now have their restream URLs registered, with the full
   * token set as (re)loaded. For a recovered camera these are its STORED tokens;
   * for a released one the broker mints new ones and persists them.
   */
  readonly onRegister: (
    tokens: ReadonlyMap<number, RtspTokensOfDevice>,
    cameras: readonly number[],
  ) => Promise<void>
  readonly recheckMs?: number
}

/** Classify every held camera against the keychain: wait for it, or give up on the value. */
export async function classifyHeld(
  held: ReadonlyMap<number, unknown>,
  secrets: TokenSecrets,
): Promise<readonly HeldCamera[]> {
  const refs = new Map<number, string>()
  for (const [deviceId, stored] of held) {
    if (isSecretMarker(stored)) refs.set(deviceId, stored.$secret)
  }
  if (refs.size === 0) return []
  const resolved = await secrets.resolve([...refs.values()])
  const out: HeldCamera[] = []
  for (const [deviceId, ref] of refs) {
    const entry = resolved[ref]
    if (entry === undefined || entry.kind === 'unavailable') {
      out.push({
        deviceId,
        ref,
        kind: 'unavailable',
        reason: entry?.kind === 'unavailable' ? entry.reason : null,
      })
    } else if (entry.kind === 'missing') {
      out.push({ deviceId, ref, kind: 'missing', reason: null })
    } else if (entry.kind === 'forbidden') {
      out.push({ deviceId, ref, kind: 'unavailable', reason: 'forbidden' })
    }
    // `value`: it resolves now - the next load picks it up.
  }
  return out
}

const UNAVAILABLE_TEXT =
  "The camera's RTSP restream URLs are unavailable (consumers such as Home Assistant or an NVR get errors) until the keychain is readable. Its streams and recording are not affected."

const issuedText = (deviceId: number): string =>
  `New RTSP restream URLs were issued for camera ${deviceId} - update the consumers (NVR, Home Assistant). The previous tokens were lost: the keychain no longer holds them.`

export class TokenRecovery {
  /** Cameras alerted as unavailable: the alert is cleared when the value resolves. */
  private readonly waiting = new Set<number>()
  /** Consecutive `missing` reads per camera (D49: two before the value is given up). */
  private readonly missingReads = new Map<number, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly deps: TokenRecoveryDeps) {}

  /** Cameras currently blocked. */
  blocked(): readonly number[] {
    return [...this.deps.mirror.heldDevices().keys()].toSorted((a, b) => a - b)
  }

  /** Check now, then on a timer while any camera is still held. */
  start(): void {
    if (this.timer !== null) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.recheckMs ?? HELD_TOKEN_RECHECK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** One scheduled / change-triggered check; never overlaps itself, never throws. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.check()
    } catch (err: unknown) {
      this.deps.logger.warn('restream-token re-check failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      this.running = false
    }
    // Nothing left to watch: stop the timer.
    if (this.blocked().length === 0 && this.waiting.size === 0) this.stop()
  }

  /** See the module doc. Idempotent. */
  async check(): Promise<void> {
    const before = new Set(this.deps.mirror.heldDevices().keys())
    if (before.size === 0 && this.waiting.size === 0) return
    const tokens = await this.deps.mirror.load()
    // A snapshot: `release` below edits the live map.
    const now = new Set(this.deps.mirror.heldDevices().keys())
    const classified = await classifyHeld(this.deps.mirror.heldDevices(), this.deps.secrets)
    const released: number[] = []
    for (const camera of classified) {
      if (camera.kind === 'missing') {
        const reads = (this.missingReads.get(camera.deviceId) ?? 0) + 1
        this.missingReads.set(camera.deviceId, reads)
        if (reads < 2) continue
        // Two consistent reads: the value is gone. Nothing is left to protect.
        this.deps.mirror.release(camera.deviceId)
        this.missingReads.delete(camera.deviceId)
        if (this.waiting.delete(camera.deviceId)) await this.deps.alerts.clear(camera.deviceId)
        released.push(camera.deviceId)
        continue
      }
      this.missingReads.delete(camera.deviceId)
      if (this.waiting.has(camera.deviceId)) continue
      this.waiting.add(camera.deviceId)
      this.deps.logger.error('restream tokens held but not readable', {
        tags: { deviceId: camera.deviceId },
        meta: { reason: camera.reason, ref: camera.ref },
      })
      await this.deps.alerts.raise({
        deviceId: camera.deviceId,
        kind: 'unavailable',
        message: UNAVAILABLE_TEXT,
      })
    }
    // Recovered = blocked BEFORE this look and not blocked NOW (and not given up
    // on): it must not depend on an alert having been raised, or a keychain that
    // unlocks between hydration and the first tick would never register the
    // stored tokens.
    const recovered = [...before].filter((id) => !now.has(id) && !released.includes(id))
    for (const deviceId of recovered) {
      if (this.waiting.delete(deviceId)) await this.deps.alerts.clear(deviceId)
    }
    if (recovered.length > 0) {
      this.deps.logger.info('restream tokens readable again', {
        meta: { cameras: recovered.length },
      })
    }
    // Recovered cameras register with their STORED tokens; released ones with
    // freshly minted tokens that the broker persists at once.
    const cameras = [...recovered, ...released]
    if (cameras.length > 0) await this.deps.onRegister(tokens, cameras)
    for (const deviceId of released) {
      this.deps.logger.error('restream tokens lost - new URLs issued', {
        tags: { deviceId },
      })
      await this.deps.alerts.raise({
        deviceId,
        kind: 'missing',
        message: issuedText(deviceId),
      })
    }
  }
}
