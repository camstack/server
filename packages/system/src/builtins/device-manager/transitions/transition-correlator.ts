/**
 * The correlator of the device transition audit (D1022).
 *
 * A command (what the kernel saw leave its caller) and a slice change (what the
 * hub mirror saw land) are two facts about one event. This module pairs them:
 * a change of an audited field is attributed to the newest pending command whose
 * effect names that field and value, else to a command with no effect (toggle,
 * press), else to the device itself. A command whose target already held is
 * `already`; one that produced nothing inside its window is `unconfirmed`; one
 * the caller saw throw is `failed`.
 *
 * Pure and clock-injected. It reads memory only (D49): the pending ring and the
 * mirror's current slice. Nothing here does I/O, so a state write never waits on
 * the audit; what it produces is handed to `emit`, whose queue is bounded.
 */
import {
  auditedFields,
  commandEffect,
  type CommandEffect,
  type DeviceCommandObservation,
  type DeviceTransition,
  type IScopedLogger,
  type TransitionValue,
} from '@camstack/types'
import { redactLogText } from '../../../logging/log-redactor.js'

/** How long a command waits for the change it should cause. */
export const COMMAND_MATCH_WINDOW_MS = 30_000
/** Pending commands kept per (device, cap); the oldest is expired when a ninth arrives. */
export const PENDING_RING_MAX = 8
/**
 * A cap's audited fields are SETTLED before they are written: changes are held as one burst per
 * (device, cap) and written, one row per field, when the burst ends. It ends when a pending
 * command is matched by its effect (written at once, credited to the command), or when the cap
 * has been quiet for this long. A cover that reports `open`, `position 6`, `opening`, then `open`
 * and `position 100` is one change per field (`closed -> open`, `0 -> 100`), not five.
 */
export const SETTLE_QUIET_MS = 5_000
/** A burst that never goes quiet (a flapping sensor) is written anyway after this long. */
export const SETTLE_MAX_HOLD_MS = 60_000
/** Longest error text a row keeps. */
const ERROR_MAX_CHARS = 300
/** The field of a row whose command named none (a toggle that changed nothing we saw). */
export const NO_FIELD = '*'

export type CurrentSlice = (
  deviceId: number,
  capName: string,
) => Readonly<Record<string, unknown>> | undefined

export interface CorrelatorDeps {
  /** Optional: names the branches that write nothing (a there-and-back field, a dropped burst). */
  readonly logger?: IScopedLogger
  readonly now: () => number
  readonly currentSlice: CurrentSlice
  readonly emit: (transition: DeviceTransition) => void
  /** The command's arguments as a row stores them: redacted by the input schema's secret paths and capped. */
  readonly prepareArgs: (
    capName: string,
    method: string,
    args: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>
}

/** One audited field that changed: before and after, and whether the mirror had ever held it. */
interface FieldChange {
  readonly field: string
  readonly before: unknown
  readonly after: unknown
  readonly neverHeld: boolean
}

interface HeldField {
  /** The value before the first change of the burst. */
  readonly before: unknown
  /** The latest value. */
  readonly after: unknown
  /** The mirror had never held the field before the burst. */
  readonly neverHeld: boolean
}

interface HeldBurst {
  readonly deviceId: number
  readonly capName: string
  readonly fields: Map<string, HeldField>
  readonly firstAt: number
  lastAt: number
}

interface Pending {
  readonly commandId: string
  readonly obs: DeviceCommandObservation
  readonly effect: CommandEffect | null
  readonly expiresAt: number
  /** The audited field's value when the command arrived, `null` when unknown. */
  readonly fromAtCommand: TransitionValue
  settled: boolean
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A status value in the shape a transition stores: unknown is `null` (D393), an array is wrapped. */
export function toTransitionValue(value: unknown): TransitionValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) return { items: value }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value))
  }
  return String(value)
}

export class TransitionCorrelator {
  private readonly pending = new Map<string, Pending[]>()
  private seq = 0
  private readonly held = new Map<string, HeldBurst>()

  constructor(private readonly deps: CorrelatorDeps) {}

  /** A command left its caller. */
  recordCommand(obs: DeviceCommandObservation): void {
    const effect = commandEffect(obs.capName, obs.method, obs.args)
    const current = this.deps.currentSlice(obs.deviceId, obs.capName)
    const fromAtCommand = effect === null ? null : toTransitionValue(current?.[effect.field])
    const commandId = this.nextCommandId(obs)
    const entry: Pending = {
      commandId,
      obs,
      effect,
      expiresAt: obs.at + COMMAND_MATCH_WINDOW_MS,
      fromAtCommand,
      settled: false,
    }
    if (
      effect !== null &&
      current !== undefined &&
      Object.hasOwn(current, effect.field) &&
      sameValue(current[effect.field], effect.value)
    ) {
      entry.settled = true
      this.emit(
        entry,
        'already',
        effect.field,
        fromAtCommand,
        toTransitionValue(effect.value),
        null,
      )
      return
    }
    const key = this.keyOf(obs.deviceId, obs.capName)
    const ring = this.pending.get(key) ?? []
    ring.push(entry)
    while (ring.length > PENDING_RING_MAX) {
      const oldest = ring.shift()
      if (oldest !== undefined) this.expire(oldest)
    }
    this.pending.set(key, ring)
    obs.outcome?.catch((err: unknown) => this.fail(entry, err))
  }

  /** The mirror stored a new native slice for `capName` (the previous one, if any, is `prior`). */
  onSliceChange(
    deviceId: number,
    capName: string,
    prior: Readonly<Record<string, unknown>> | undefined,
    slice: Readonly<Record<string, unknown>>,
  ): void {
    const fields = auditedFields(capName)
    if (fields.size === 0) return
    const now = this.deps.now()
    const changes: FieldChange[] = []
    for (const field of fields) {
      const hadBefore = prior !== undefined && Object.hasOwn(prior, field)
      const has = Object.hasOwn(slice, field)
      if (!hadBefore && !has) continue
      const before = hadBefore ? prior[field] : undefined
      const after = has ? slice[field] : undefined
      if (sameValue(before, after)) continue
      changes.push({ field, before, after, neverHeld: !hadBefore })
    }
    if (changes.length === 0) return
    const key = this.keyOf(deviceId, capName)
    const burst = this.held.get(key) ?? {
      deviceId,
      capName,
      fields: new Map<string, HeldField>(),
      firstAt: now,
      lastAt: now,
    }
    burst.lastAt = now
    const claimable = this.hasLiveCommand(deviceId, capName, now)
    for (const change of changes) {
      const earlier = burst.fields.get(change.field)
      // A field the mirror never held (the first slice of a cap, or one that arrives in steps
      // after a boot or restore) is the device being learned, not changing: only a pending
      // command can claim it, and it is never folded into a burst as a `from`.
      if (change.neverHeld && earlier === undefined && !claimable) continue
      burst.fields.set(change.field, {
        before: earlier !== undefined ? earlier.before : change.before,
        after: change.after,
        neverHeld: earlier !== undefined ? earlier.neverHeld : change.neverHeld,
      })
    }
    if (burst.fields.size === 0) return
    this.held.set(key, burst)
    // A command fulfilled by the value that just arrived ends the burst at once, even when the
    // burst as a whole netted to nothing (the device went back to where the burst began).
    if (this.commandMatchedBy(deviceId, capName, changes, now) !== undefined) {
      this.flushBurst(key, burst)
    }
  }

  private hasLiveCommand(deviceId: number, capName: string, now: number): boolean {
    return (this.pending.get(this.keyOf(deviceId, capName)) ?? []).some(
      (e) => !e.settled && e.expiresAt > now,
    )
  }

  /** Write every held burst now (shutdown): a held change must not be lost (D49). */
  flush(): void {
    for (const [key, burst] of [...this.held]) this.flushBurst(key, burst)
  }

  /** The fields of a burst that ended somewhere other than where they started. */
  private netChanges(burst: HeldBurst): FieldChange[] {
    return [...burst.fields]
      .filter(([, f]) => !sameValue(f.before, f.after))
      .map(([field, f]) => ({ field, ...f }))
  }

  private flushBurst(key: string, burst: HeldBurst): void {
    this.held.delete(key)
    const net = this.netChanges(burst)
    const { deviceId, capName } = burst
    for (const field of burst.fields.keys()) {
      if (net.some((c) => c.field === field)) continue
      this.deps.logger?.debug(
        `device-transitions: ${capName}.${field} went and came back inside one burst; no row`,
        { tags: { deviceId } },
      )
    }
    // The command one burst belongs to is decided first, from every field the burst touched, so
    // the order the audited fields are visited in never decides who a sibling is credited to.
    const touched = [...burst.fields].map(([field, f]) => ({ field, ...f }))
    let claimed: Pending | undefined = this.commandMatchedBy(
      deviceId,
      capName,
      touched,
      burst.lastAt,
    )
    for (const change of net) {
      claimed = this.attribute(
        deviceId,
        capName,
        change.field,
        toTransitionValue(change.before),
        toTransitionValue(change.after),
        burst.lastAt,
        claimed,
        change.neverHeld,
      )
    }
    // The command reached its target but the burst netted to nothing on that field: the actor
    // really acted, so the command is confirmed with the burst's before and the target.
    const effect = claimed?.effect
    if (claimed !== undefined && effect !== null && effect !== undefined) {
      if (!net.some((c) => c.field === effect.field)) {
        const before = burst.fields.get(effect.field)?.before
        this.confirmWithoutNet(
          key,
          claimed,
          effect.field,
          toTransitionValue(before),
          toTransitionValue(effect.value),
          burst.lastAt,
        )
      }
    }
  }

  private confirmWithoutNet(
    key: string,
    entry: Pending,
    field: string,
    from: TransitionValue,
    to: TransitionValue,
    at: number,
  ): void {
    entry.settled = true
    this.emit(entry, 'confirmed', field, from, to, at - entry.obs.at, undefined, at)
    this.pruneSettled(key)
  }

  private pruneSettled(key: string): void {
    const ring = this.pending.get(key)
    if (ring === undefined) return
    const rest = ring.filter((e) => !e.settled)
    if (rest.length === 0) this.pending.delete(key)
    else this.pending.set(key, rest)
  }

  private flushDue(now: number): void {
    for (const [key, burst] of [...this.held]) {
      if (now - burst.lastAt >= SETTLE_QUIET_MS || now - burst.firstAt >= SETTLE_MAX_HOLD_MS) {
        this.flushBurst(key, burst)
      }
    }
  }

  /** The newest live command whose effect one of `changes` fulfils, if any. */
  private commandMatchedBy(
    deviceId: number,
    capName: string,
    changes: readonly { readonly field: string; readonly after: unknown }[],
    now: number,
  ): Pending | undefined {
    const live = (this.pending.get(this.keyOf(deviceId, capName)) ?? []).filter(
      (e) => !e.settled && e.expiresAt > now,
    )
    return [...live]
      .reverse()
      .find(
        (e) =>
          e.effect !== null &&
          changes.some(
            (c) =>
              e.effect !== null &&
              e.effect.field === c.field &&
              sameValue(e.effect.value, toTransitionValue(c.after)),
          ),
      )
  }

  /** Expire every pending command past its window. Driven by the sender's tick. */
  sweep(): void {
    const now = this.deps.now()
    this.flushDue(now)
    for (const [key, ring] of this.pending) {
      const live: Pending[] = []
      for (const entry of ring) {
        if (entry.settled) continue
        if (entry.expiresAt <= now) this.expire(entry)
        else live.push(entry)
      }
      if (live.length === 0) this.pending.delete(key)
      else this.pending.set(key, live)
    }
  }

  /** Commands still waiting, for a status read. */
  pendingCount(): number {
    let n = 0
    for (const ring of this.pending.values()) n += ring.filter((e) => !e.settled).length
    return n
  }

  /** Forget a removed device's pending commands. */
  forgetDevice(deviceId: number): void {
    const prefix = `${deviceId}|`
    for (const key of [...this.held.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.deps.logger?.debug(
        `device-transitions: device removed with a held ${key.slice(prefix.length)} burst; dropped`,
        { tags: { deviceId } },
      )
      this.held.delete(key)
    }
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(prefix)) this.pending.delete(key)
    }
  }

  private attribute(
    deviceId: number,
    capName: string,
    field: string,
    from: TransitionValue,
    to: TransitionValue,
    now: number,
    claimedByThisWrite: Pending | undefined,
    neverHeld: boolean,
  ): Pending | undefined {
    const key = this.keyOf(deviceId, capName)
    const ring = this.pending.get(key)
    const live = (ring ?? []).filter((e) => !e.settled && e.expiresAt > now)
    const byEffect = [...live]
      .reverse()
      .find((e) => e.effect !== null && e.effect.field === field && sameValue(e.effect.value, to))
    const matched =
      byEffect ?? claimedByThisWrite ?? [...live].reverse().find((e) => e.effect === null)
    if (matched === undefined) {
      // A field the mirror never held (the first slice of a cap, or one that arrives in steps
      // after a boot or restore) is the device being learned, not changing: with no command to
      // claim it, no row.
      if (neverHeld) return undefined
      this.writeDevice(deviceId, capName, field, from, to, now)
      return undefined
    }
    matched.settled = true
    this.emit(matched, 'confirmed', field, from, to, now - matched.obs.at, undefined, now)
    this.pruneSettled(key)
    return matched
  }

  private expire(entry: Pending): void {
    if (entry.settled) return
    entry.settled = true
    const field = entry.effect?.field ?? NO_FIELD
    this.emit(entry, 'unconfirmed', field, entry.fromAtCommand, entry.fromAtCommand, null)
  }

  private fail(entry: Pending, err: unknown): void {
    if (entry.settled) return
    entry.settled = true
    const message = err instanceof Error ? err.message : String(err)
    const field = entry.effect?.field ?? NO_FIELD
    this.emit(entry, 'failed', field, entry.fromAtCommand, entry.fromAtCommand, null, message)
  }

  private emit(
    entry: Pending,
    outcome: 'confirmed' | 'already' | 'unconfirmed' | 'failed',
    field: string,
    from: TransitionValue,
    to: TransitionValue,
    matchedAfterMs: number | null,
    error?: string,
    at: number = this.deps.now(),
  ): void {
    const { obs } = entry
    this.deps.emit({
      id: this.nextId(obs.deviceId, at),
      deviceId: obs.deviceId,
      at,
      capName: obs.capName,
      field,
      from,
      to,
      outcome,
      actor: obs.actor,
      command: {
        commandId: entry.commandId,
        method: obs.method,
        args: this.deps.prepareArgs(obs.capName, obs.method, obs.args),
        requestedAt: obs.at,
        matchedAfterMs,
        ...(error !== undefined ? { error: redactLogText(error).slice(0, ERROR_MAX_CHARS) } : {}),
      },
    })
  }

  /** A change nobody asked for. */
  private writeDevice(
    deviceId: number,
    capName: string,
    field: string,
    from: TransitionValue,
    to: TransitionValue,
    at: number,
  ): void {
    this.deps.emit({
      id: this.nextId(deviceId, at),
      deviceId,
      at,
      capName,
      field,
      from,
      to,
      outcome: 'device',
      actor: { kind: 'device' },
    })
  }

  private keyOf(deviceId: number, capName: string): string {
    return `${deviceId}|${capName}`
  }

  private nextId(deviceId: number, at: number): string {
    this.seq += 1
    return `${deviceId}:${at}:${this.seq}`
  }

  private nextCommandId(obs: DeviceCommandObservation): string {
    this.seq += 1
    return `${obs.deviceId}:${obs.at}:c${this.seq}`
  }
}
