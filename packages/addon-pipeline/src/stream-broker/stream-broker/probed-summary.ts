/**
 * Pure formatter for the per-stream "Probed" readonly field shown in the
 * stream-broker device settings contribution (one sub-tab per stream).
 *
 * The string blends two data sources of differing availability:
 *   - DECLARED values (`codec` / `resolution` / `fps`) come from the
 *     publisher's `CameraStream` and are available even while the stream is
 *     suspended.
 *   - PROBED runtime values (detected codec, bitrate, IDR interval, audio
 *     track) come from `BrokerStats` and exist only while the broker is
 *     actively pulling. The manager persists the LAST such snapshot so the
 *     field stays populated after the stream goes idle (with an "as of" tag).
 *
 * Keeping this pure (no `Date.now`, no I/O) makes it unit-testable and keeps
 * the manager free of string-assembly noise.
 */

import { z } from 'zod'

/** Publisher-declared stream metadata (always available). */
export interface ProbedDeclared {
  readonly codec?: string
  readonly resolution?: { readonly width: number; readonly height: number }
  readonly fps?: number
}

/**
 * Last-observed runtime probe (present only after the stream was pulled once).
 * Zod-backed because it is persisted durably (ONE ROW per broker in
 * `stream-broker:probe-snapshots`) so the field stays populated across a hub
 * restart — the schema is the single source of truth, applied per row.
 */
export const ProbedSnapshotSchema = z.object({
  /** Detected video codec — preferred over the declared one when present. */
  codec: z.string().optional(),
  bitrateKbps: z.number(),
  idrIntervalMs: z.number(),
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.number(),
      channels: z.number(),
      supported: z.boolean(),
    })
    .nullable(),
  /** Epoch ms the snapshot was captured. */
  at: z.number(),
})
export type ProbedSnapshot = z.infer<typeof ProbedSnapshotSchema>

/**
 * The manager's in-memory probe map, keyed by `brokerIdFor(deviceId,
 * camStreamId)`.
 *
 * NOT the durable shape any more: since the 2026-08-19 flatten each snapshot is
 * its own row in `stream-broker:probe-snapshots`, validated one at a time by
 * {@link ProbedSnapshotSchema}. This stays as the schema for the whole map the
 * manager hands out and takes back.
 */
export const ProbedSnapshotMapSchema = z.record(z.string(), ProbedSnapshotSchema)
export type ProbedSnapshotMap = z.infer<typeof ProbedSnapshotMapSchema>

export interface FormatProbedOptions {
  /** Pre-formatted clock label (e.g. "10:38") appended as "· as of <asOf>". */
  readonly asOf?: string
}

const SEP = ' · '

function formatCodec(codec: string): string {
  const lower = codec.toLowerCase()
  if (lower === 'h264') return 'H.264'
  if (lower === 'h265' || lower === 'hevc') return 'H.265'
  return codec.toUpperCase()
}

function formatBitrate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`
}

function formatSampleRate(hz: number): string {
  // 16000 → "16kHz", 44100 → "44.1kHz". Drop trailing ".0" via String().
  return `${String(hz / 1000)}kHz`
}

function formatChannels(channels: number): string {
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels}ch`
}

function formatAudio(audio: ProbedSnapshot['audio']): string {
  if (audio === null) return 'Audio: none'
  const tail = audio.supported ? '' : ' (unsupported)'
  return `Audio: ${audio.codec} ${formatSampleRate(audio.sampleRate)} ${formatChannels(audio.channels)}${tail}`
}

/**
 * Build the readonly summary string for one stream.
 *
 * @param declared Publisher-declared metadata (codec/resolution/fps).
 * @param snapshot Last runtime probe, or `null` if the stream was never pulled.
 * @param opts     Optional pre-formatted "as of" clock label.
 */
export function formatProbedSummary(
  declared: ProbedDeclared,
  snapshot: ProbedSnapshot | null,
  opts?: FormatProbedOptions,
): string {
  const parts: string[] = []

  const codec = snapshot?.codec ?? declared.codec
  if (codec) parts.push(formatCodec(codec))
  if (declared.resolution) parts.push(`${declared.resolution.width}×${declared.resolution.height}`)
  if (declared.fps) parts.push(`${Math.round(declared.fps)}fps`)

  if (snapshot === null) {
    if (parts.length === 0) return 'not yet probed'
    parts.push('Audio: — (not yet probed)')
    return parts.join(SEP)
  }

  // A freshly force-probed stream reports bitrateKbps=0 (the 2s average hasn't
  // filled) and a near-zero idrIntervalMs (only one IDR seen) — those are
  // "not measured yet" sentinels, not real values, so omit them.
  if (snapshot.bitrateKbps > 0) parts.push(formatBitrate(snapshot.bitrateKbps))
  if (snapshot.idrIntervalMs >= 100)
    parts.push(`IDR ${(snapshot.idrIntervalMs / 1000).toFixed(1)}s`)
  parts.push(formatAudio(snapshot.audio))
  if (opts?.asOf) parts.push(`as of ${opts.asOf}`)

  return parts.join(SEP)
}
