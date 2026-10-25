/**
 * The dial DECLARATION carried on the restream path: what this consumer is,
 * and how much retained history it asks for.
 *
 * A muted (local-decoder loopback) session is withheld the join burst whenever
 * the ring burst is older than `LIVE_EDGE_MAX_SPAN_MS` — a rule measured for
 * re-clocked consumers with ~zero decode headroom. A per-session DETECTION
 * decode has headroom by construction (it decodes at source rate and publishes
 * throttled by the FrameSlot), so it must be able to say so at dial time. It
 * says it in the only channel the RTSP dial has: the path.
 *
 * The SECOND half of the declaration is the amount (D382). D381 made the
 * broker the only thing that decides how much history exists; it left the
 * consumer's ASK implicit, so declaring an intent — which detection does for
 * the live-edge exemption, an unrelated reason — meant being handed the whole
 * retained window. An unstated amount is now ZERO: history reaches a consumer
 * that named a number, and nobody else.
 *
 * These are the two halves of that channel — the writer (the decode dial) and
 * the reader (the listen server) — kept as ONE pure module so they cannot
 * drift apart.
 */
import { describe, expect, it } from 'vitest'
import { PREBUFFER_MAX_MS } from '../../prebuffer.js'
import {
  DETECTION_MUTED_PATH_SUFFIX,
  DETECTION_PRE_ROLL_REQUEST_MS,
  MUTED_PATH_SUFFIX,
  parseRestreamPath,
  RECORDING_PRE_ROLL_REQUEST_MS,
  withDetectionIntent,
  withRecordingIntent,
} from '../restream-intent.js'

describe('parseRestreamPath', () => {
  it('reads a detection-intent muted path as muted + detection intent', () => {
    expect(parseRestreamPath(`tok-abc${DETECTION_MUTED_PATH_SUFFIX}`)).toEqual({
      lookupPath: 'tok-abc',
      muted: true,
      declaration: { intent: 'detection', preRollRequestMs: 0 },
    })
  })

  it('reads a plain muted path as muted with NO intent (today, byte-for-byte)', () => {
    expect(parseRestreamPath(`tok-abc${MUTED_PATH_SUFFIX}`)).toEqual({
      lookupPath: 'tok-abc',
      muted: true,
      declaration: { intent: null, preRollRequestMs: 0 },
    })
  })

  it('reads a bare token as neither muted nor intent-bearing', () => {
    expect(parseRestreamPath('tok-abc')).toEqual({
      lookupPath: 'tok-abc',
      muted: false,
      declaration: { intent: null, preRollRequestMs: 0 },
    })
  })

  it('does not mistake a token that merely CONTAINS the suffix text', () => {
    expect(parseRestreamPath('muted-detection')).toEqual({
      lookupPath: 'muted-detection',
      muted: false,
      declaration: { intent: null, preRollRequestMs: 0 },
    })
  })
})

describe('the pre-roll REQUEST segment (D382)', () => {
  it('an intent WITHOUT a request asks for zero history', () => {
    // The whole point of the record: detection declares its intent for the
    // live-edge exemption, which is not a request for history. Before D382 the
    // same declaration was served the entire retained window.
    expect(parseRestreamPath(`tok-abc${DETECTION_MUTED_PATH_SUFFIX}`).declaration).toEqual({
      intent: 'detection',
      preRollRequestMs: 0,
    })
  })

  it('reads the request that follows the intent suffix', () => {
    expect(parseRestreamPath('tok-abc/muted-detection/preroll-4000')).toEqual({
      lookupPath: 'tok-abc',
      muted: true,
      declaration: { intent: 'detection', preRollRequestMs: 4000 },
    })
    expect(parseRestreamPath('tok-abc/recording/preroll-15000')).toEqual({
      lookupPath: 'tok-abc',
      muted: false,
      declaration: { intent: 'recording', preRollRequestMs: 15_000 },
    })
  })

  it('caps a request at the widest window a prebuffer can hold', () => {
    expect(
      parseRestreamPath('tok-abc/recording/preroll-9999999').declaration.preRollRequestMs,
    ).toBe(PREBUFFER_MAX_MS)
  })

  it('a request WITHOUT an intent is not a request — the token keeps its own name', () => {
    // Nothing dials this. If something ever does, the honest reading is that the
    // path is not one this module minted, so it is a token, not a declaration.
    const parsed = parseRestreamPath('tok-abc/preroll-4000')
    expect(parsed.declaration).toEqual({ intent: null, preRollRequestMs: 0 })
  })

  it('an unparseable amount asks for zero, never for everything', () => {
    expect(
      parseRestreamPath('tok-abc/muted-detection/preroll-abc').declaration.preRollRequestMs,
    ).toBe(0)
    expect(parseRestreamPath('tok-abc/muted-detection/preroll-').declaration.preRollRequestMs).toBe(
      0,
    )
  })
})

describe('withDetectionIntent', () => {
  it('rewrites the muted restream URL to its detection-intent variant', () => {
    expect(withDetectionIntent('rtsp://127.0.0.1:8554/tok-abc/muted', 0)).toBe(
      'rtsp://127.0.0.1:8554/tok-abc/muted-detection',
    )
  })

  it('states the amount it asks for, when it asks for one', () => {
    expect(withDetectionIntent('rtsp://127.0.0.1:8554/tok-abc/muted', 4000)).toBe(
      'rtsp://127.0.0.1:8554/tok-abc/muted-detection/preroll-4000',
    )
  })

  it('leaves a NON-muted URL untouched — there is no withhold to be exempt from', () => {
    // `resolveSourceUrl` falls back to the audio-bearing URL when the broker
    // has no muted variant; that session is not muted, so the live-edge rule
    // never applied to it and the intent would only break the path lookup.
    expect(withDetectionIntent('rtsp://127.0.0.1:8554/tok-abc', 4000)).toBe(
      'rtsp://127.0.0.1:8554/tok-abc',
    )
  })

  it('is idempotent — including the amount it already states', () => {
    expect(withDetectionIntent('rtsp://127.0.0.1:8554/tok-abc/muted-detection', 0)).toBe(
      'rtsp://127.0.0.1:8554/tok-abc/muted-detection',
    )
    expect(
      withDetectionIntent('rtsp://127.0.0.1:8554/tok-abc/muted-detection/preroll-4000', 4000),
    ).toBe('rtsp://127.0.0.1:8554/tok-abc/muted-detection/preroll-4000')
  })
})

describe('the RECORDING intent (audit 2026-08-20)', () => {
  it('parses the recording suffix, NOT muted — a recording keeps its audio', () => {
    expect(parseRestreamPath('tok-abc/recording')).toEqual({
      lookupPath: 'tok-abc',
      muted: false,
      declaration: { intent: 'recording', preRollRequestMs: 0 },
    })
  })

  it('appends the suffix to a plain (audio-bearing) url', () => {
    expect(withRecordingIntent('rtsp://127.0.0.1:8554/tok-abc', 0)).toBe(
      'rtsp://127.0.0.1:8554/tok-abc/recording',
    )
  })

  it('is idempotent', () => {
    expect(withRecordingIntent('rtsp://127.0.0.1:8554/tok-abc/recording', 0)).toBe(
      'rtsp://127.0.0.1:8554/tok-abc/recording',
    )
  })

  it('leaves a MUTED url alone — appending would break the token lookup', () => {
    expect(withRecordingIntent('rtsp://127.0.0.1:8554/tok-abc/muted', 15_000)).toBe(
      'rtsp://127.0.0.1:8554/tok-abc/muted',
    )
    expect(withRecordingIntent('rtsp://127.0.0.1:8554/tok-abc/muted-detection', 15_000)).toBe(
      'rtsp://127.0.0.1:8554/tok-abc/muted-detection',
    )
  })

  it('round-trips: what the recorder writes is what the listen server reads', () => {
    const dialed = withRecordingIntent('tok-abc', RECORDING_PRE_ROLL_REQUEST_MS)
    expect(parseRestreamPath(dialed).lookupPath).toBe('tok-abc')
    expect(parseRestreamPath(dialed).declaration).toEqual({
      intent: 'recording',
      preRollRequestMs: RECORDING_PRE_ROLL_REQUEST_MS,
    })
  })

  it('the detection dial round-trips its own request the same way', () => {
    const dialed = withDetectionIntent('tok-abc/muted', DETECTION_PRE_ROLL_REQUEST_MS)
    expect(parseRestreamPath(dialed).lookupPath).toBe('tok-abc')
    expect(parseRestreamPath(dialed).declaration).toEqual({
      intent: 'detection',
      preRollRequestMs: DETECTION_PRE_ROLL_REQUEST_MS,
    })
  })
})
