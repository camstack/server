/**
 * Debug WATCH — a short, per-device window over a `debug.<channel>` line.
 *
 * The operator switches a debug channel on for one or more devices, reads it
 * live, and it switches itself off. Between watches a debug line costs one
 * boolean load: the thunk that builds it is never run, and the log ring never
 * accepts it.
 *
 * Three pieces, none of which reads a store or does a call per line (D49):
 *
 * - {@link DebugWatchTable} — what the HUB's log service holds. A pure table
 *   with an injected clock: start, re-arm, stop, and the two ceilings.
 * - {@link DebugInterest} — the in-memory MIRROR every process keeps. Moved
 *   only by `apply` (a full set, pushed by the hub through the `log-channels`
 *   capability) and by `tick` on a timer, never from a log path.
 * - {@link createDebugEmitter} — the `ctx.debug(channel, deviceId, thunk)`
 *   shape, which consults the mirror before it runs the thunk.
 */

import type { IScopedLogger, LogTags } from '../interfaces/logging.js'
import type { LogChannelWindow } from './log-channel.js'

/** Every debug channel's name starts with this; the ring denies it by default. */
export const DEBUG_CHANNEL_PREFIX = 'debug.'

/** One watch lasts this long without a re-arm. */
export const DEBUG_WATCH_WINDOW_MS = 10 * 60_000
/** The page re-arms this often while it stays open. */
export const DEBUG_WATCH_REARM_EVERY_MS = 4 * 60_000
/** No chain of re-arms outlives this, measured from the watch's first start. */
export const DEBUG_WATCH_HARD_CAP_MS = 60 * 60_000

export function isDebugChannelName(name: string): boolean {
  return name.startsWith(DEBUG_CHANNEL_PREFIX)
}

/** One live watch, as the page is shown it. */
export interface DebugWatchState {
  readonly channel: string
  readonly deviceIds: readonly number[]
  readonly startedAtMs: number
  /** When interest drops if nobody re-arms. Never past `capAtMs`. */
  readonly untilMs: number
  readonly capAtMs: number
}

interface StoredWatch {
  readonly deviceIds: readonly number[]
  readonly startedAtMs: number
  readonly untilMs: number
}

export type DebugRearmOutcome = 'rearmed' | 'capped' | 'lapsed'

export class DebugWatchTable {
  private readonly watches = new Map<string, StoredWatch>()

  /**
   * Start a watch, or re-arm the one already running. A start on a live watch
   * keeps its original start: pressing Start again must not be a way past the
   * hard cap.
   */
  start(channel: string, deviceIds: readonly number[], nowMs: number): DebugWatchState {
    this.expire(nowMs)
    const existing = this.watches.get(channel)
    const startedAtMs = existing?.startedAtMs ?? nowMs
    const untilMs = Math.min(nowMs + DEBUG_WATCH_WINDOW_MS, startedAtMs + DEBUG_WATCH_HARD_CAP_MS)
    this.watches.set(channel, { deviceIds: [...deviceIds], startedAtMs, untilMs })
    return {
      channel,
      deviceIds: [...deviceIds],
      startedAtMs,
      untilMs,
      capAtMs: startedAtMs + DEBUG_WATCH_HARD_CAP_MS,
    }
  }

  /**
   * Extend a LIVE watch. A lapsed one is not revived — an open page that
   * outlived its cap must not quietly start a new one.
   */
  rearm(channel: string, nowMs: number): DebugRearmOutcome {
    this.expire(nowMs)
    const existing = this.watches.get(channel)
    if (existing === undefined) return 'lapsed'
    const capAtMs = existing.startedAtMs + DEBUG_WATCH_HARD_CAP_MS
    const untilMs = Math.min(nowMs + DEBUG_WATCH_WINDOW_MS, capAtMs)
    this.watches.set(channel, { ...existing, untilMs })
    return untilMs >= capAtMs ? 'capped' : 'rearmed'
  }

  stop(channel: string): void {
    this.watches.delete(channel)
  }

  /** Drop what has lapsed; the names it closed. */
  expire(nowMs: number): readonly string[] {
    const closed: string[] = []
    for (const [channel, watch] of this.watches) {
      if (watch.untilMs <= nowMs) {
        this.watches.delete(channel)
        closed.push(channel)
      }
    }
    return closed
  }

  states(nowMs: number): readonly DebugWatchState[] {
    this.expire(nowMs)
    const out: DebugWatchState[] = []
    for (const channel of this.watches.keys()) {
      const state = this.describe(channel, nowMs)
      if (state !== null) out.push(state)
    }
    return out
  }

  /** The live watches as the windows every gate and mirror is pushed. */
  windows(nowMs: number): readonly LogChannelWindow[] {
    return this.states(nowMs).map((state) => ({
      channel: state.channel,
      armedUntilMs: state.untilMs,
      deviceIds: state.deviceIds,
    }))
  }

  private describe(channel: string, nowMs: number): DebugWatchState | null {
    const watch = this.watches.get(channel)
    if (watch === undefined || watch.untilMs <= nowMs) return null
    return {
      channel,
      deviceIds: watch.deviceIds,
      startedAtMs: watch.startedAtMs,
      untilMs: watch.untilMs,
      capAtMs: watch.startedAtMs + DEBUG_WATCH_HARD_CAP_MS,
    }
  }
}

interface InterestWindow {
  readonly untilMs: number
  readonly devices: ReadonlySet<number> | null
}

/**
 * Who is watching what, in THIS process. In-memory, moved off the log path.
 *
 * `active` is a plain boolean FIELD, read first: with no watch anywhere, a
 * `ctx.debug` call is one load and one branch.
 */
export class DebugInterest {
  active = false

  private readonly windows = new Map<string, InterestWindow>()

  /**
   * Replace the interest with the FULL set of windows. Non-debug windows are
   * ignored and an absent one is dropped, so a lost disarm cannot leave a
   * channel running.
   */
  apply(windows: readonly LogChannelWindow[], nowMs: number): void {
    this.windows.clear()
    for (const window of windows) {
      if (!isDebugChannelName(window.channel) || window.armedUntilMs <= nowMs) continue
      const ids = window.deviceIds
      this.windows.set(window.channel, {
        untilMs: window.armedUntilMs,
        devices: ids === null || ids.length === 0 ? null : new Set(ids),
      })
    }
    this.active = this.windows.size > 0
  }

  /** Drop what has lapsed. Called on a timer, never from a log path. */
  tick(nowMs: number): readonly string[] {
    const closed: string[] = []
    for (const [name, window] of this.windows) {
      if (window.untilMs <= nowMs) {
        this.windows.delete(name)
        closed.push(name)
      }
    }
    this.active = this.windows.size > 0
    return closed
  }

  /** `channel` is the full name, `debug.<channel>`. */
  wants(channel: string, deviceId: number): boolean {
    if (!this.active) return false
    const window = this.windows.get(channel)
    if (window === undefined) return false
    return window.devices === null || window.devices.has(deviceId)
  }
}

let interestInstance: DebugInterest | null = null

export function getDebugInterest(): DebugInterest {
  interestInstance ??= new DebugInterest()
  return interestInstance
}

export function __resetDebugInterestForTests(): void {
  interestInstance = null
}

/** What a `ctx.debug` thunk returns: the line, built only when watched. */
export interface DebugLine {
  readonly message: string
  readonly meta?: Record<string, unknown>
}

export type DebugEmitter = (channel: string, deviceId: number, thunk: () => DebugLine) => void

/**
 * Build `ctx.debug`. The thunk runs ONLY when somebody watches this
 * (channel, device) pair, and the line carries `tags: { deviceId }` plus the
 * `debug.<channel>` name as `logChannel`.
 */
export function createDebugEmitter(
  logger: IScopedLogger,
  interest: DebugInterest = getDebugInterest(),
): DebugEmitter {
  return (channel, deviceId, thunk) => {
    if (!interest.active) return
    const name = `${DEBUG_CHANNEL_PREFIX}${channel}`
    if (!interest.wants(name, deviceId)) return
    const line = thunk()
    const tags: LogTags = { deviceId, logChannel: name }
    logger.info(line.message, line.meta === undefined ? { tags } : { tags, meta: line.meta })
  }
}
