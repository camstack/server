/** Pure helpers for the Logs → Diagnostics page. */
import type { DebugWatchState, LogChannelDescriptor } from '@dominevo/types'

/** `4m 12s`. Never a bare millisecond count — a deadline has to be readable. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds}s`
  if (seconds === 0) return `${minutes}m`
  return `${minutes}m ${seconds}s`
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

/** The addon a channel belongs to: its name up to the first dot. */
export function addonOfChannel(channelName: string): string {
  const dot = channelName.indexOf('.')
  return dot === -1 ? channelName : channelName.slice(0, dot)
}

export interface ChannelGroup {
  readonly addon: string
  readonly channels: readonly LogChannelDescriptor[]
}

/** One group per addon, groups and the channels inside them sorted by name. */
export function groupChannelsByAddon(
  channels: readonly LogChannelDescriptor[],
): readonly ChannelGroup[] {
  const byAddon = new Map<string, LogChannelDescriptor[]>()
  for (const channel of channels) {
    const addon = addonOfChannel(channel.name)
    byAddon.set(addon, [...(byAddon.get(addon) ?? []), channel])
  }
  return [...byAddon.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([addon, list]) => ({
      addon,
      channels: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    }))
}
