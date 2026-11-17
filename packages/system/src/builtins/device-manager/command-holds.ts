/**
 * The command hold (D1061): what a device was just told to do, shown at once.
 *
 * A command arms a hold on each field its effects name; the mirror reads the
 * device's slice through it (the EFFECTIVE slice) while the slice it stores,
 * persists and records stays what the device reported. Each held field
 * remembers what the device reported for it when the command arrived. A
 * reading of a held field is
 *   - STALE when it equals that pre-command value (or a value an older,
 *     replaced command held): the device has not acted yet — keep holding;
 *   - the CONFIRMATION when it equals the held value, a number within the
 *     effect's tolerance (the step of the arg it came from) — release;
 *   - the DEVICE'S OWN ANSWER otherwise (locking, jammed, arming, a value
 *     rounded beyond the step) — release at once and serve it (logged at
 *     debug, `device-answered`).
 * A held field also ends when the call is refused (rolled back at once), when
 * the limit elapses with the device still stale (reverted, warned), or when a
 * newer command names the same field (latest wins).
 *
 * Memory only: a restart drops every hold. Nothing here does I/O; the timers
 * are unref'd so a hold never keeps a process alive.
 */
import type { CommandEffect, IScopedLogger, VocabEffectValue } from '@camstack/types'
import { ONE_SHOT_HOLD_MS } from '@camstack/types'

type Slice = Readonly<Record<string, unknown>>

interface HeldField {
  readonly value: VocabEffectValue
  readonly tolerance: number
  /** What the device reported before the command(s): a reading equal to one of these is stale. */
  readonly stale: readonly unknown[]
  readonly token: number
}

interface Arming {
  readonly token: number
  readonly deviceId: number
  readonly capName: string
  readonly method: string
  readonly holdMs: number
  readonly timer: ReturnType<typeof setTimeout>
}

/** Why a hold ended other than by confirmation. */
export type HoldRelease = 'refused' | 'unconfirmed'

export interface CommandHoldsDeps {
  readonly logger: IScopedLogger
  /** The slice the hold sits on (native, or a claim's merge), `null` when the cap has none. */
  readonly baseSlice: (deviceId: number, capName: string) => Slice | null
  /** Re-emit the cap: the held set changed while the slice under it did not. */
  readonly reemit: (deviceId: number, capName: string) => void
}

/** What one command armed. */
export interface ArmRequest {
  readonly deviceId: number
  readonly capName: string
  readonly method: string
  readonly effects: readonly CommandEffect[]
  readonly holdMs: number
}

function same(a: unknown, b: unknown): boolean {
  return Object.is(a, b)
}

/** Does `reading` confirm `held`: equal, or a number within its tolerance? */
function confirms(reading: unknown, held: VocabEffectValue, tolerance: number): boolean {
  if (same(reading, held)) return true
  if (typeof reading !== 'number' || typeof held !== 'number' || tolerance <= 0) return false
  // A float step (0.5 °C) must not lose an exact match to rounding noise.
  return Math.abs(reading - held) <= tolerance + 1e-9
}

/** What a reading of a held field means. */
type Reading = 'stale' | 'confirmed' | 'device-answered'

function judge(reading: unknown, held: HeldField): Reading {
  if (confirms(reading, held.value, held.tolerance)) return 'confirmed'
  if (held.stale.some((v) => same(v, reading))) return 'stale'
  return 'device-answered'
}

export class CommandHolds {
  /** device → cap → field → held value. */
  private readonly held = new Map<number, Map<string, Map<string, HeldField>>>()
  private readonly armings = new Map<number, Arming>()
  private seq = 0

  constructor(private readonly deps: CommandHoldsDeps) {}

  /**
   * Hold what a command leads to. A field the slice already holds is not held
   * (and a standing hold on it is dropped: the newer command wins). Returns the
   * token that `release` takes, or `null` when nothing is held.
   */
  arm(request: ArmRequest): number | null {
    const base = this.deps.baseSlice(request.deviceId, request.capName)
    if (base === null) {
      this.deps.logger.debug('command hold: the cap has no slice yet — nothing held', {
        tags: { deviceId: request.deviceId },
        meta: { cap: request.capName, method: request.method },
      })
      return null
    }
    this.seq += 1
    const token = this.seq
    const fields = this.fieldsOf(request.deviceId, request.capName)
    let changed = false
    let holding = false
    for (const effect of request.effects) {
      const standing = fields.get(effect.field)
      const tolerance = effect.tolerance ?? 0
      const reported = Object.hasOwn(base, effect.field) ? base[effect.field] : undefined
      if (Object.hasOwn(base, effect.field) && confirms(reported, effect.value, tolerance)) {
        if (standing !== undefined) {
          fields.delete(effect.field)
          changed = true
        }
        continue
      }
      if (standing === undefined || !same(standing.value, effect.value)) changed = true
      // A value the replaced command held is the device catching up, not an answer.
      const stale = standing === undefined ? [reported] : [...standing.stale, standing.value]
      fields.set(effect.field, { value: effect.value, tolerance, stale, token })
      holding = true
    }
    this.dropEmpty(request.deviceId, request.capName)
    this.forgetStaleArmings()
    if (holding) {
      const timer = setTimeout(() => this.release(token, 'unconfirmed'), request.holdMs)
      timer.unref?.()
      this.armings.set(token, {
        token,
        deviceId: request.deviceId,
        capName: request.capName,
        method: request.method,
        holdMs: request.holdMs,
        timer,
      })
    }
    if (changed) this.deps.reemit(request.deviceId, request.capName)
    return holding ? token : null
  }

  /** End what `token` still holds — refused at once, or unconfirmed at the limit. */
  release(token: number, reason: HoldRelease): void {
    const arming = this.armings.get(token)
    if (arming === undefined) return
    this.armings.delete(token)
    clearTimeout(arming.timer)
    const fields = this.held.get(arming.deviceId)?.get(arming.capName)
    if (fields === undefined) return
    const dropped: string[] = []
    for (const [field, held] of fields) {
      if (held.token !== token) continue
      fields.delete(field)
      dropped.push(field)
    }
    if (dropped.length === 0) return
    this.dropEmpty(arming.deviceId, arming.capName)
    const tags = { deviceId: arming.deviceId }
    const meta = { cap: arming.capName, method: arming.method, fields: dropped }
    if (reason === 'unconfirmed' && arming.holdMs <= ONE_SHOT_HOLD_MS) {
      // A one-shot (feed, run) usually finishes before the next poll: its end is the normal case.
      this.deps.logger.debug('one-shot command hold ended', { tags, meta })
    } else if (reason === 'unconfirmed') {
      this.deps.logger.warn('command hold reverted: the device did not confirm in time', {
        tags,
        meta,
      })
    } else {
      this.deps.logger.info('command hold rolled back: the command was refused', { tags, meta })
    }
    this.deps.reemit(arming.deviceId, arming.capName)
  }

  /**
   * The slice under the hold moved: keep each held field it still reports
   * stale, drop the ones it confirms or answers otherwise.
   */
  settle(deviceId: number, capName: string, base: Slice): void {
    const fields = this.held.get(deviceId)?.get(capName)
    if (fields === undefined) return
    for (const [field, held] of fields) {
      if (!Object.hasOwn(base, field)) continue
      const reading = judge(base[field], held)
      if (reading === 'stale') continue
      fields.delete(field)
      if (reading === 'device-answered') {
        this.deps.logger.debug('command hold released: the device answered otherwise', {
          tags: { deviceId },
          meta: { cap: capName, field, reason: reading },
        })
      }
    }
    this.dropEmpty(deviceId, capName)
    this.forgetStaleArmings()
  }

  /** `base` with the held values over it; `base` itself when nothing is held. */
  overlay(deviceId: number, capName: string, base: Slice): Slice {
    const fields = this.held.get(deviceId)?.get(capName)
    if (fields === undefined || fields.size === 0) return base
    const out: Record<string, unknown> = { ...base }
    for (const [field, held] of fields) out[field] = held.value
    return out
  }

  /** Is any field of the cap held? */
  isHolding(deviceId: number, capName: string): boolean {
    return (this.held.get(deviceId)?.get(capName)?.size ?? 0) > 0
  }

  /** Forget a removed device's holds. */
  clearDevice(deviceId: number): void {
    this.held.delete(deviceId)
    for (const [token, arming] of this.armings) {
      if (arming.deviceId !== deviceId) continue
      clearTimeout(arming.timer)
      this.armings.delete(token)
    }
  }

  /** Stop every timer (shutdown). */
  dispose(): void {
    for (const arming of this.armings.values()) clearTimeout(arming.timer)
    this.armings.clear()
    this.held.clear()
  }

  private fieldsOf(deviceId: number, capName: string): Map<string, HeldField> {
    const perCap = this.held.get(deviceId) ?? new Map<string, Map<string, HeldField>>()
    this.held.set(deviceId, perCap)
    const fields = perCap.get(capName) ?? new Map<string, HeldField>()
    perCap.set(capName, fields)
    return fields
  }

  private dropEmpty(deviceId: number, capName: string): void {
    const perCap = this.held.get(deviceId)
    if (perCap === undefined) return
    if ((perCap.get(capName)?.size ?? 0) === 0) perCap.delete(capName)
    if (perCap.size === 0) this.held.delete(deviceId)
  }

  /** An arming whose fields were all confirmed or replaced holds nothing: stop its timer. */
  private forgetStaleArmings(): void {
    for (const [token, arming] of this.armings) {
      const fields = this.held.get(arming.deviceId)?.get(arming.capName)
      const owns = fields !== undefined && [...fields.values()].some((f) => f.token === token)
      if (owns) continue
      clearTimeout(arming.timer)
      this.armings.delete(token)
    }
  }
}
