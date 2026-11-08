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
  type TransitionValue,
} from '@camstack/types'
import { redactLogText } from '../../../logging/log-redactor.js'

/** How long a command waits for the change it should cause. */
export const COMMAND_MATCH_WINDOW_MS = 30_000
/** Pending commands kept per (device, cap); the oldest is expired when a ninth arrives. */
export const PENDING_RING_MAX = 8
/**
 * A device-origin change of one field is written at most once per this window; changes inside it
 * are coalesced into one row (first `from` to last `to`) released by the next sweep. A chatty
 * field (a flapping contact, a bouncing state) would otherwise write a row per poll. Commands are
 * never bounded: each is a decision somebody made.
 */
export const DEVICE_ROW_WINDOW_MS = 10_000
/** Longest error text a row keeps. */
const ERROR_MAX_CHARS = 300
/** The field of a row whose command named none (a toggle that changed nothing we saw). */
export const NO_FIELD = '*'

export type CurrentSlice = (
  deviceId: number,
  capName: string,
) => Readonly<Record<string, unknown>> | undefined

export interface CorrelatorDeps {
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

interface DeviceRowWindow {
  /** When the last row of this field was written. */
  lastEmitAt: number
  /** Changes seen since then, not yet written. */
  held?: { readonly from: TransitionValue; to: TransitionValue; at: number }
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
  private readonly deviceRows = new Map<string, DeviceRowWindow>()

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
    // The command one write was attributed to: its other changed fields are its too.
    let claimed: Pending | undefined
    for (const field of fields) {
      const hadBefore = prior !== undefined && Object.hasOwn(prior, field)
      const has = Object.hasOwn(slice, field)
      if (!hadBefore && !has) continue
      const before = hadBefore ? prior[field] : undefined
      const after = has ? slice[field] : undefined
      if (sameValue(before, after)) continue
      claimed = this.attribute(
        deviceId,
        capName,
        field,
        toTransitionValue(before),
        toTransitionValue(after),
        now,
        claimed,
        prior === undefined,
      )
    }
  }

  /** Expire every pending command past its window. Driven by the sender's tick. */
  sweep(): void {
    const now = this.deps.now()
    this.releaseDeviceRows(now)
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
    for (const key of [...this.deviceRows.keys()]) {
      if (key.startsWith(prefix)) this.deviceRows.delete(key)
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
    firstSlice: boolean,
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
      // The first slice the mirror ever holds for a cap is the device being learned (a boot, a
      // restore, a new device), not the device changing: with no command to claim it, no row.
      if (firstSlice) return undefined
      this.emitDevice(deviceId, capName, field, from, to, now)
      return undefined
    }
    matched.settled = true
    this.emit(matched, 'confirmed', field, from, to, now - matched.obs.at)
    if (ring !== undefined) {
      const rest = ring.filter((e) => !e.settled)
      if (rest.length === 0) this.pending.delete(key)
      else this.pending.set(key, rest)
    }
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
  ): void {
    const { obs } = entry
    const at = this.deps.now()
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

  /** A change nobody asked for, bounded per field (see {@link DEVICE_ROW_WINDOW_MS}). */
  private emitDevice(
    deviceId: number,
    capName: string,
    field: string,
    from: TransitionValue,
    to: TransitionValue,
    at: number,
  ): void {
    const key = `${deviceId}|${capName}|${field}`
    const window = this.deviceRows.get(key)
    if (window === undefined || at - window.lastEmitAt >= DEVICE_ROW_WINDOW_MS) {
      this.writeDevice(deviceId, capName, field, from, to, at)
      this.deviceRows.set(key, { lastEmitAt: at })
      return
    }
    window.held = { from: window.held?.from ?? from, to, at }
  }

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

  /** Release coalesced device rows whose window has closed; forget windows nothing is held in. */
  private releaseDeviceRows(now: number): void {
    for (const [key, window] of this.deviceRows) {
      if (now - window.lastEmitAt < DEVICE_ROW_WINDOW_MS) continue
      const held = window.held
      this.deviceRows.delete(key)
      if (held === undefined || sameValue(held.from, held.to)) continue
      const [deviceId, capName, ...rest] = key.split('|')
      this.writeDevice(Number(deviceId), capName ?? '', rest.join('|'), held.from, held.to, held.at)
      this.deviceRows.set(key, { lastEmitAt: now })
    }
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
