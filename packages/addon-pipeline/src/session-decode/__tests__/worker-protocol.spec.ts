import { describe, expect, it } from 'vitest'
import { isWorkerReply, isWorkerRequest, logLevelForLine } from '../worker-protocol.js'

describe('worker protocol guards', () => {
  it('accepts a valid frame reply and rejects a malformed one', () => {
    expect(
      isWorkerReply({
        kind: 'frame',
        frameId: 1,
        timestamp: 10,
        width: 4,
        height: 4,
        format: 'gray',
      }),
    ).toBe(true)
    expect(isWorkerReply({ kind: 'frame', frameId: 'x' })).toBe(false)
    expect(isWorkerReply({ kind: 'nope' })).toBe(false)
  })

  it('round-trips every WorkerReply variant', () => {
    expect(
      isWorkerReply({
        kind: 'frame',
        frameId: 2,
        timestamp: 5,
        width: 640,
        height: 480,
        format: 'rgb',
      }),
    ).toBe(true)
    expect(isWorkerReply({ kind: 'buffer', frameId: 2, bytes: new Uint8Array([1, 2, 3]) })).toBe(
      true,
    )
    expect(isWorkerReply({ kind: 'ended' })).toBe(true)
    expect(isWorkerReply({ kind: 'error', message: 'boom' })).toBe(true)
  })

  it('accepts a complete dialTiming reply and rejects a partial one', () => {
    expect(
      isWorkerReply({
        kind: 'dialTiming',
        hwContextMs: 12,
        demuxerOpenMs: 2_640,
        decoderCreateMs: 90,
        firstDecodeMs: 310,
        streamInfoProbed: false,
      }),
    ).toBe(true)
    // Every field is load-bearing: a partial split that passed the guard would
    // surface as `undefined` on the operator's line, which reads as "that step
    // was not measured" when it in fact was not SENT.
    expect(
      isWorkerReply({
        kind: 'dialTiming',
        hwContextMs: 12,
        demuxerOpenMs: 2_640,
        decoderCreateMs: 90,
        firstDecodeMs: 310,
      }),
    ).toBe(false)
    expect(
      isWorkerReply({
        kind: 'dialTiming',
        hwContextMs: 12,
        demuxerOpenMs: 2_640,
        decoderCreateMs: 90,
        firstDecodeMs: 310,
        streamInfoProbed: 'yes',
      }),
    ).toBe(false)
  })

  it('accepts nativeCropMiss with and without a reason', () => {
    expect(isWorkerReply({ kind: 'nativeCropMiss', requestId: 4 })).toBe(true)
    expect(
      isWorkerReply({ kind: 'nativeCropMiss', requestId: 4, reason: 'crop failed — sws' }),
    ).toBe(true)
    expect(isWorkerReply({ kind: 'nativeCropMiss', requestId: 4, reason: 5 })).toBe(false)
  })

  it('accepts a well-formed log reply and rejects a malformed one', () => {
    expect(isWorkerReply({ kind: 'log', level: 'warn', message: 'native crop failed' })).toBe(true)
    expect(isWorkerReply({ kind: 'log', level: 'debug', message: 'provenance' })).toBe(true)
    expect(isWorkerReply({ kind: 'log', level: 'verbose', message: 'x' })).toBe(false)
    expect(isWorkerReply({ kind: 'log', level: 'warn' })).toBe(false)
  })

  it('classifies failure lines as warn and routine lines as debug', () => {
    expect(logLevelForLine('decode-worker-child: native crop failed (requestId 3) — sws')).toBe(
      'warn',
    )
    expect(logLevelForLine('native lease download failed — EIO')).toBe('warn')
    expect(logLevelForLine('uncaught exception — boom')).toBe('warn')
    expect(logLevelForLine('decode-worker-child: GPU crop+scale path active')).toBe('debug')
    expect(logLevelForLine('color provenance sw-crop bt709')).toBe('debug')
  })

  it('rejects malformed WorkerReply variants', () => {
    expect(isWorkerReply(null)).toBe(false)
    expect(isWorkerReply(undefined)).toBe(false)
    expect(isWorkerReply('frame')).toBe(false)
    expect(
      isWorkerReply({
        kind: 'frame',
        frameId: 1,
        timestamp: 10,
        width: 4,
        height: 4,
        format: 'bgr',
      }),
    ).toBe(false)
    expect(isWorkerReply({ kind: 'buffer', frameId: 1, bytes: [1, 2, 3] })).toBe(false)
    expect(isWorkerReply({ kind: 'error', message: 42 })).toBe(false)
  })

  it('round-trips every WorkerRequest variant', () => {
    expect(
      isWorkerRequest({
        kind: 'start',
        source: { restreamUrl: 'rtsp://x', deviceId: 1, codec: 'h264' },
        opts: { fps: 5, format: 'gray' },
        hwaccel: ['vaapi'],
        lease: {
          values: {
            holdFrames: 8,
            budgetMb: 1024,
            activityMs: 15_000,
            admission: 'inferred',
            tileBudgetMb: 64,
            sceneBudgetMb: 48,
          },
          sources: {
            holdFrames: 'default',
            budgetMb: 'default',
            activityMs: 'default',
            admission: 'default',
            tileBudgetMb: 'default',
            sceneBudgetMb: 'default',
          },
        },
      }),
    ).toBe(true)
    expect(isWorkerRequest({ kind: 'pull' })).toBe(true)
    expect(isWorkerRequest({ kind: 'toBuffer', frameId: 3 })).toBe(true)
    expect(
      isWorkerRequest({
        kind: 'toBuffer',
        frameId: 3,
        opts: {
          crop: { left: 0, top: 0, width: 10, height: 10 },
          resize: { width: 5, height: 5 },
          format: 'jpeg',
        },
      }),
    ).toBe(true)
    expect(isWorkerRequest({ kind: 'stop' })).toBe(true)
    // D652: stop decoding, keep the frames already handed out.
    expect(isWorkerRequest({ kind: 'drain' })).toBe(true)
  })

  it('rejects malformed WorkerRequest variants', () => {
    expect(isWorkerRequest(null)).toBe(false)
    expect(isWorkerRequest({ kind: 'start', source: { restreamUrl: 'x' }, opts: {} })).toBe(false)
    expect(isWorkerRequest({ kind: 'toBuffer', frameId: 'not-a-number' })).toBe(false)
    expect(
      isWorkerRequest({ kind: 'toBuffer', frameId: 1, opts: { crop: { left: 0, top: 0 } } }),
    ).toBe(false)
    expect(isWorkerRequest({ kind: 'unknown' })).toBe(false)
  })
})

// ── The lease knobs travel on `start`, never in the fork env (D453) ──────────
//
// A child that resolved its knobs from the environment at module load was a
// child bound to the configuration it was BORN with — which a pre-forked
// (zygote) worker cannot be. And it needed `@camstack/types` (the Zod schemas)
// inside the child to do it, which cost every fork ~130 ms and ~140 MB before
// the first packet. The parent resolves; the child receives.
const LEASE = {
  values: {
    holdFrames: 8,
    budgetMb: 1024,
    activityMs: 15_000,
    admission: 'inferred',
    tileBudgetMb: 64,
    sceneBudgetMb: 48,
  },
  sources: {
    holdFrames: 'default',
    budgetMb: 'setting',
    activityMs: 'env',
    admission: 'default',
    tileBudgetMb: 'default',
    sceneBudgetMb: 'default',
  },
}
const SOURCE = { restreamUrl: 'rtsp://x', deviceId: 1, codec: 'h264' }

describe('worker protocol — lease knobs on start', () => {
  it('a start WITHOUT the knobs is malformed: an absent knob set is a default acting without a decision', () => {
    expect(isWorkerRequest({ kind: 'start', source: SOURCE, opts: {} })).toBe(false)
  })

  it('a start carrying a well-formed knob set is accepted', () => {
    expect(
      isWorkerRequest({ kind: 'start', source: SOURCE, opts: {}, lease: LEASE, hwaccel: null }),
    ).toBe(true)
  })

  it('a start WITHOUT the hwaccel offer is malformed (D926); a junk backend is refused', () => {
    expect(isWorkerRequest({ kind: 'start', source: SOURCE, opts: {}, lease: LEASE })).toBe(false)
    expect(
      isWorkerRequest({ kind: 'start', source: SOURCE, opts: {}, lease: LEASE, hwaccel: ['gpu'] }),
    ).toBe(false)
    expect(
      isWorkerRequest({ kind: 'start', source: SOURCE, opts: {}, lease: LEASE, hwaccel: [] }),
    ).toBe(true)
  })

  it('rejects a knob set with a hold of 0, a junk admission word, or an unknown source', () => {
    const bad = (patch: Record<string, unknown>): boolean =>
      isWorkerRequest({
        kind: 'start',
        source: SOURCE,
        opts: {},
        lease: { ...LEASE, ...patch },
        hwaccel: null,
      })
    expect(bad({ values: { ...LEASE.values, holdFrames: 0 } })).toBe(false)
    expect(bad({ values: { ...LEASE.values, admission: 'some' } })).toBe(false)
    expect(bad({ sources: { ...LEASE.sources, budgetMb: 'guess' } })).toBe(false)
    expect(bad({ values: { ...LEASE.values, budgetMb: Number.NaN } })).toBe(false)
  })

  it('round-trips the `ready` reply a pre-forked worker sends once its native modules are loaded', () => {
    expect(isWorkerReply({ kind: 'ready', warm: true })).toBe(true)
    expect(isWorkerReply({ kind: 'ready', warm: false })).toBe(true)
    expect(isWorkerReply({ kind: 'ready' })).toBe(false)
  })
})

describe('worker protocol — the pre-roll report and its late settle line (D652)', () => {
  const base = {
    kind: 'preRollReport',
    offered: 20,
    inferred: 7,
    dropped: 13,
    droppedByReason: { stride: 13 },
    strideMs: 171,
    subsampled: true,
    spanMs: 1200,
  }
  it('the report carries the effective (hold-capped) budget', () => {
    expect(isWorkerReply({ ...base, budgetFrames: 7 })).toBe(true)
    expect(isWorkerReply(base)).toBe(false)
  })
  const settled = {
    kind: 'preRollSettled',
    read: 5,
    released: 1,
    lostByReason: { evicted: 1, cleared: 0, 'download-failed': 0, miss: 0 },
    unsettled: 0,
  }
  it('accepts a complete settle line', () => {
    expect(isWorkerReply(settled)).toBe(true)
  })
  it('rejects a settle line missing a loss reason — an absent count must not read as zero', () => {
    expect(isWorkerReply({ ...settled, lostByReason: { evicted: 1, cleared: 0, miss: 0 } })).toBe(
      false,
    )
    expect(isWorkerReply({ ...settled, unsettled: undefined })).toBe(false)
  })
})
