import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecordedFeeder, type FeederState, type LocateResult } from '../recorded-feeder'
import { demuxSegmentToAnnexB } from '../segment-demux'
import { demuxSegmentToPcmu } from '../segment-audio'

/**
 * Integration test: drive the REAL RecordedFeeder through the REAL ffmpeg
 * demuxers (segment-demux + segment-audio) with a real HEVC+AAC recording
 * fragment — the exact path a WebRTC scrub exercises, minus the werift RTP
 * egress (unchanged pre-existing code). Proves the feeder correctly reads a
 * segment, demuxes it via ffmpeg, and pushes re-stamped H.265 access units +
 * PCMU audio to a sink. Requires ffmpeg on PATH (dev + hub + agent images).
 */
const SAMPLE = new Uint8Array(readFileSync(join(__dirname, 'fixtures/sample.m4s')))
/** The binary the product would run: CI exports the pinned build here (D540). */
const FFMPEG = process.env['CAMSTACK_FFMPEG_PATH'] ?? 'ffmpeg'

interface PushedVideo {
  readonly len: number
  readonly rtpTs90k: number
  readonly codec: 'H264' | 'H265'
}
interface PushedAudio {
  readonly len: number
  readonly rtpTs8k: number
}

describe('RecordedFeeder ↔ real ffmpeg demux', () => {
  it('reads a segment, demuxes via ffmpeg, and pushes H.265 video + PCMU audio to the sink', async () => {
    const video: PushedVideo[] = []
    const audio: PushedAudio[] = []
    const states: FeederState[] = []

    // Locate returns exactly one segment covering the seek; a gap thereafter.
    const locate = async ({ epochMs }: { epochMs: number }): Promise<LocateResult> =>
      epochMs <= 4000
        ? { kind: 'segment', startMs: 0, durMs: 4000, bytes: SAMPLE.length }
        : { kind: 'gap', nearestEdgeMs: null }

    const feeder = new RecordedFeeder({
      deviceId: 104,
      profile: 'high',
      locate,
      readBytes: async () => SAMPLE,
      demux: (b) => demuxSegmentToAnnexB(b, FFMPEG),
      demuxAudio: (b) => demuxSegmentToPcmu(b, FFMPEG),
      sink: {
        pushAccessUnit: (annexB, rtpTs90k, codec) =>
          video.push({ len: annexB.length, rtpTs90k, codec }),
        pushAudioPcmu: (pcmu, rtpTs8k) => audio.push({ len: pcmu.length, rtpTs8k }),
      },
      onState: (s) => states.push(s.to),
      onPosition: () => {},
    })

    // Rate 1 seek bursts the IDR→epoch prefix (video-only decode priming) and
    // PACES the remainder (incl. audio) from the cursor. Seek mid-segment so
    // the prefix carries several AUs, then wait a short real-time window for
    // the paced remainder to deliver the first audio frames.
    await feeder.seek(2000)
    await new Promise((r) => setTimeout(r, 300))
    feeder.dispose()

    // Video: the single-GOP fragment yields multiple AUs, all H.265, and the
    // first is the params-fused IDR (Annex-B start code present).
    expect(video.length).toBeGreaterThan(1)
    expect(video.every((v) => v.codec === 'H265')).toBe(true)
    expect(video.every((v) => v.len > 0)).toBe(true)
    // rtp timestamps are non-decreasing (MonotonicClock re-stamped source PTS).
    for (let i = 1; i < video.length; i++)
      expect(video[i]!.rtpTs90k).toBeGreaterThanOrEqual(video[i - 1]!.rtpTs90k)

    // Audio: PCMU 20 ms frames (160 bytes) pushed alongside the video.
    expect(audio.length).toBeGreaterThan(0)
    expect(audio.every((a) => a.len === 160)).toBe(true)

    // The feeder reached a terminal non-error state.
    expect(states).toContain('loading')
    expect(states).not.toContain('error')
  })
})
