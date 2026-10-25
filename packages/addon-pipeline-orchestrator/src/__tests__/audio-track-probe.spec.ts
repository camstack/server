/**
 * `BrokerStats.audio === null` answers two different questions, and the whole
 * value of this classifier is refusing to conflate them. Every case below is a
 * state a live broker actually reports.
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_PROBE_SETTLE_MS,
  type AudioTrackProbeStats,
  classifyAudioTrackProbe,
} from '../audio-track-probe.js'

function stats(overrides: Partial<AudioTrackProbeStats> = {}): AudioTrackProbeStats {
  return { status: 'streaming', uptimeMs: 60_000, audio: null, ...overrides }
}

describe('classifyAudioTrackProbe', () => {
  it('reports the codec when a track is declared', () => {
    expect(classifyAudioTrackProbe(stats({ audio: { codec: 'PCMU' } }))).toEqual({
      kind: 'present',
      codec: 'PCMU',
    })
  })

  it('says ABSENT only for a settled, streaming broker with no track', () => {
    expect(classifyAudioTrackProbe(stats())).toEqual({ kind: 'absent' })
  })

  it('says UNKNOWN for an idle/suspended broker — the cold read that disarmed 618', () => {
    // A broker that is not pulling has not looked at an SDP; its `audio: null`
    // is silence about the question, not an answer to it.
    expect(classifyAudioTrackProbe(stats({ status: 'idle', uptimeMs: 0 })).kind).toBe('unknown')
    expect(classifyAudioTrackProbe(stats({ status: 'connecting' })).kind).toBe('unknown')
    expect(classifyAudioTrackProbe(stats({ status: 'error' })).kind).toBe('unknown')
  })

  it('says UNKNOWN while a fresh stream is still settling', () => {
    // A push source declares its audio with `pushAudioInfo`, which may trail
    // the first VIDEO packet.
    expect(classifyAudioTrackProbe(stats({ uptimeMs: AUDIO_PROBE_SETTLE_MS - 1 })).kind).toBe(
      'unknown',
    )
    expect(classifyAudioTrackProbe(stats({ uptimeMs: AUDIO_PROBE_SETTLE_MS })).kind).toBe('absent')
  })

  it('treats a MISSING `audio` field as no evidence, never as absence', () => {
    // The field is optional on the wire. A producer that never fills it (version
    // skew) must not read as "no camera in the fleet has audio".
    expect(classifyAudioTrackProbe({ status: 'streaming', uptimeMs: 60_000 }).kind).toBe('unknown')
    expect(classifyAudioTrackProbe({ status: 'idle', uptimeMs: 0, audio: undefined }).kind).toBe(
      'unknown',
    )
  })
})
