/** Pure helpers for the Logs → Watch page. */
import type { DebugWatchState } from '@camstack/types'

/** `4m 12s`. Never a bare millisecond count — a deadline has to be readable. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** The picker hands back strings; only whole numbers are device ids. */
export function parseDeviceIds(values: readonly string[]): readonly number[] {
  return values.filter((v) => /^\d+$/.test(v)).map((v) => Number(v))
}

/** What a watch has left, and what the hard cap leaves of it. */
export function watchCountdown(
  watch: DebugWatchState,
  nowMs: number,
): { readonly windowMs: number; readonly capMs: number } {
  return {
    windowMs: Math.max(0, watch.untilMs - nowMs),
    capMs: Math.max(0, watch.capAtMs - nowMs),
  }
}

/** The channels the page keeps alive: the ones both live and selected. */
export function channelsToRearm(
  watches: readonly DebugWatchState[],
  selected: readonly string[],
): readonly string[] {
  const live = new Set(watches.map((w) => w.channel))
  return selected.filter((channel) => live.has(channel))
}
