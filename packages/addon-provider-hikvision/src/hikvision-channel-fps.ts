import type { HikvisionDeviceCache } from './schema.js'

/**
 * Read the channel's probed `maxFrameRate` from the cached device probe.
 *
 * `parseChannelsList` (the list endpoint at `/ISAPI/Streaming/channels`)
 * doesn't include `maxFrameRate`; only the per-channel resource
 * `/ISAPI/Streaming/channels/{id}` does. `probeAndPersistFeatures` runs
 * that per-channel fetch once at boot (parallel with the dynamicCap
 * read) and persists the result into `deviceCache.streamSnapshots[id]`
 * — so the broker's `stream-catalog` pull (~30s) can read fps from the
 * cache without paying an extra ISAPI round-trip per channel per pull.
 *
 * Returns the cached fps when present and positive; otherwise
 * `undefined` so `channelToDescriptor` omits the field and downstream
 * consumers (the "Source (probed)" widget card) hide the fps chip
 * rather than render a misleading zero.
 */
export function resolveProbedFps(
  channelId: string,
  deviceCache: HikvisionDeviceCache | undefined,
): number | undefined {
  const snapshot = deviceCache?.streamSnapshots?.[channelId]
  const fps = snapshot?.maxFrameRate
  if (fps === null || fps === undefined) return undefined
  if (fps <= 0) return undefined
  return fps
}
