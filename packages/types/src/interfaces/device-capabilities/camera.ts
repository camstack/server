import type { StreamSourceEntry } from '../../device/camera-device.js'
import type { CamProfile } from '../../capabilities/schemas/streaming-shared.js'

// ---------------------------------------------------------------------------
// Stream metadata — probed (ffprobe) or declared by provider
// ---------------------------------------------------------------------------

export interface StreamMetadata {
  width?: number // e.g. 1920
  height?: number // e.g. 1080
  codec?: string // e.g. 'h264', 'h265', 'mjpeg', 'vp8', 'vp9', 'av1'
  fps?: number // e.g. 25
  bitrateKbps?: number // e.g. 4000
  /** Probed audio track. Undefined when stream carries no audio. */
  audio?: StreamAudioMetadata
}

export interface StreamAudioMetadata {
  /** Codec name as reported by the demuxer (e.g. 'aac', 'pcm_mulaw', 'opus'). */
  codec?: string
  /** Sample rate in Hz (e.g. 8000, 16000, 44100, 48000). */
  sampleRate?: number
  /** Channel count (1 = mono, 2 = stereo). */
  channels?: number
  /** Stated bitrate in kbps when the demuxer reports one. */
  bitrateKbps?: number
  /** Codec profile/aac-mode (e.g. 'LC', 'HE-AAC') when known. */
  profile?: string
}

// ---------------------------------------------------------------------------
// Stream quality — computed from metadata
// ---------------------------------------------------------------------------

export type StreamQuality = CamProfile

/** Friendly display labels for stream quality IDs. */
export const STREAM_QUALITY_LABELS: Readonly<Record<string, string>> = {
  high: 'High',
  mid: 'Mid',
  low: 'Low',
}

/** Get a friendly label for a stream ID. Falls back to capitalised id. */
export function streamQualityLabel(id: string): string {
  return STREAM_QUALITY_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * Compute pixel count for sorting. Returns w*h, or 0 if unknown.
 */
export function streamPixels(meta: StreamMetadata): number {
  return (meta.width ?? 0) * (meta.height ?? 0)
}

/**
 * Classify streams relative to each other.
 * Highest resolution → high, lowest → low, everything else → mid.
 * With 1 stream: high. With 2: high + low.
 */
export function classifyStreams<T extends { metadata?: StreamMetadata }>(
  streams: readonly T[],
): Array<T & { quality: StreamQuality }> {
  if (streams.length === 0) return []

  // Sort by pixel count descending
  const sorted = streams
    .map((s, i) => ({ s, i, px: streamPixels(s.metadata ?? {}) }))
    .toSorted((a, b) => b.px - a.px)

  const result: Array<T & { quality: StreamQuality }> = Array.from<T & { quality: StreamQuality }>({
    length: streams.length,
  })

  for (let rank = 0; rank < sorted.length; rank++) {
    const { s, i } = sorted[rank]!
    let quality: StreamQuality
    if (rank === 0) quality = 'high'
    else if (rank === sorted.length - 1) quality = 'low'
    else quality = 'mid'
    result[i] = { ...s, quality }
  }

  return result
}

/**
 * Classify a single stream in isolation (no relative context).
 * Use classifyStreams() when you have the full set.
 */
export function classifyStream(meta: StreamMetadata): StreamQuality {
  const h = meta.height ?? 0
  const w = meta.width ?? 0
  if (h >= 1080 || w >= 1920) return 'high'
  if (h >= 480 || w >= 640) return 'mid'
  return 'low'
}

// ---------------------------------------------------------------------------
// Stream protocol — how to consume a stream
// ---------------------------------------------------------------------------

export type StreamProtocolType = 'rtsp' | 'rtmp' | 'http' | 'flv' | 'rtp' | 'raw'

export interface StreamProtocol {
  type: StreamProtocolType
  /** Source URL. undefined for 'raw' (push-based, e.g. Reolink Baichuan). */
  url?: string
}

// ---------------------------------------------------------------------------
// AvailableStream — a physical stream exposed by a camera
// ---------------------------------------------------------------------------

export interface AvailableStream {
  /** Unique identifier within the device (e.g. 'main', 'sub', 'ch0_0') */
  id: string
  /** Ways to consume this stream */
  protocols: StreamProtocol[]
  /** Probed or provider-declared stream characteristics */
  metadata?: StreamMetadata
  /** Computed from metadata via classifyStream() */
  quality: StreamQuality
  /** Optional display hint */
  label?: string
}

/** Convert AvailableStream to StreamSourceEntry for stream-broker consumers. */
export function toStreamSourceEntry(stream: AvailableStream): StreamSourceEntry {
  // Pick first URL-bearing protocol, prefer rtsp
  const urlProto =
    stream.protocols.find((p) => p.type === 'rtsp' && p.url) ?? stream.protocols.find((p) => p.url)

  const protocolRaw = urlProto?.type
  const protocol: StreamSourceEntry['protocol'] =
    protocolRaw === 'rtsp'
      ? 'rtsp'
      : protocolRaw === 'http' || protocolRaw === 'flv'
        ? 'http-mjpeg'
        : 'custom'

  return {
    id: stream.id,
    label: stream.label ?? stream.id,
    protocol,
    url: urlProto?.url,
    profileHint: stream.quality,
  }
}

// ---------------------------------------------------------------------------
// Camera stream settings — stored in device settings by providers
// ---------------------------------------------------------------------------

/** A single stream entry in device settings. */
export interface CameraStreamEntry {
  readonly url: string
  readonly label?: string
}

export interface CameraStreamConfig {
  readonly streams: readonly CameraStreamEntry[]
  /**
   * Snapshot source URL (JPEG).
   * Used internally by the provider to implement ICamera.getSnapshot().
   * Clients should call snapshot.getSnapshot() instead of hitting this URL directly.
   */
  readonly snapshot_url?: string
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseStreamEntry(v: unknown): CameraStreamEntry | null {
  // "rtsp://..." → { url }
  if (isString(v) && v.trim()) return { url: v }
  // { url: "rtsp://...", label?: "Main" } → { url, label }
  if (isRecord(v) && isString(v['url']) && v['url'].trim()) {
    return {
      url: v['url'],
      label: isString(v['label']) ? v['label'] : undefined,
    }
  }
  return null
}

/** Extract CameraStreamConfig from untyped settings record. */
export function parseCameraStreamConfig(raw: Record<string, unknown>): CameraStreamConfig {
  const snapshotUrl = isString(raw['snapshot_url']) ? raw['snapshot_url'] : undefined

  // Array format: ["url"] or [{url, label}]
  if (Array.isArray(raw['streams'])) {
    const streams: CameraStreamEntry[] = []
    for (const item of raw['streams']) {
      const entry = parseStreamEntry(item)
      if (entry) streams.push(entry)
    }
    return { streams, snapshot_url: snapshotUrl }
  }

  // Legacy key-based format: main_stream_url, sub_stream_url, third_stream_url
  const streams: CameraStreamEntry[] = []

  const mainUrl = isString(raw['main_stream_url']) ? raw['main_stream_url'] : undefined
  if (mainUrl)
    streams.push({
      url: mainUrl,
      label: isString(raw['main_stream_name']) ? raw['main_stream_name'] : undefined,
    })

  const subUrl = isString(raw['sub_stream_url']) ? raw['sub_stream_url'] : undefined
  if (subUrl)
    streams.push({
      url: subUrl,
      label: isString(raw['sub_stream_name']) ? raw['sub_stream_name'] : undefined,
    })

  const thirdUrl = isString(raw['third_stream_url']) ? raw['third_stream_url'] : undefined
  if (thirdUrl)
    streams.push({
      url: thirdUrl,
      label: isString(raw['third_stream_name']) ? raw['third_stream_name'] : undefined,
    })

  return {
    streams,
    snapshot_url: snapshotUrl,
  }
}

// ---------------------------------------------------------------------------
// Stream Profile Assignment
// ---------------------------------------------------------------------------

/**
 * Per-device mapping of quality profile → streamId.
 * Cameras expose N physical streams; the user assigns which stream
 * serves each of the 3 standard CamStack profiles.
 */
export interface StreamProfileMap {
  high?: string
  mid?: string
  low?: string
}

/**
 * Auto-assign profiles based on quality classification.
 * With 1 stream: all profiles point to it.
 * With 2: high + low. With 3+: high + mid + low.
 */
export function autoAssignProfiles(streams: readonly AvailableStream[]): StreamProfileMap {
  if (streams.length === 0) return {}

  const classified = classifyStreams(streams)
  const map: StreamProfileMap = {}

  // Assign by quality label, not array position (classifyStreams preserves original order)
  const high = classified.find((s) => s.quality === 'high')
  const mid = classified.find((s) => s.quality === 'mid')
  const low = classified.find((s) => s.quality === 'low')

  if (high) map.high = high.id
  if (mid) map.mid = mid.id
  if (low) map.low = low.id

  // Fallback: fill missing profiles from what's available
  const fallback = high ?? mid ?? low ?? classified[0]
  if (fallback) {
    if (!map.high) map.high = fallback.id
    if (!map.mid) map.mid = fallback.id
    if (!map.low) map.low = fallback.id
  }

  return map
}

// ---------------------------------------------------------------------------
