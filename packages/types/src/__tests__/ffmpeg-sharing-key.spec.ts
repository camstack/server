/**
 * The sharing key for `streamBroker.acquireEgressTranscode`.
 *
 * The contract the operator set: **two requesters asking for EXACTLY the same
 * argument set reach the same process.** Exact — never a quantised ladder that
 * merges NEARLY-identical requests, because then the stream you receive is a
 * function of who else is watching and in what order they arrived, which is
 * unfalsifiable during a debugging session.
 *
 * The key is derived from the STRUCTURED plan. `getStreamWithCodec` folds a
 * raw `outputArgs: string[]` into its key, so its extensibility hatch and its
 * sharing key are the same field: a consumer needing one extra flag silently
 * stops sharing. Here there is no raw array, and normalisation happens before
 * hashing so two requests that MEAN the same thing hash the same even when
 * built differently.
 */
import { describe, it, expect } from 'vitest'
import {
  canonicalEgressPlan,
  egressTranscodeSharingKey,
  egressTransportFromRequest,
} from '../ffmpeg/sharing-key.js'
import type { EgressTranscodeRequest } from '../capabilities/stream-broker.cap.js'

function request(over: Partial<EgressTranscodeRequest> = {}): EgressTranscodeRequest {
  return {
    deviceId: 101,
    source: { kind: 'cam-stream', camStreamId: 'native:main' },
    encode: {
      video: {
        codec: 'h264',
        profile: 'baseline',
        level: '3.1',
        width: 1280,
        height: 720,
      },
      audio: 'passthrough',
    },
    ...over,
  }
}

describe('egressTranscodeSharingKey', () => {
  it('is identical for two structurally-equal requests', () => {
    expect(egressTranscodeSharingKey(request())).toBe(egressTranscodeSharingKey(request()))
  })

  it('is INSENSITIVE to key insertion order (same meaning ⇒ same process)', () => {
    const a: EgressTranscodeRequest = {
      deviceId: 101,
      source: { kind: 'cam-stream', camStreamId: 'native:main' },
      encode: {
        video: { codec: 'h264', width: 1280, height: 720 },
        audio: 'passthrough',
      },
    }
    const b: EgressTranscodeRequest = {
      encode: {
        audio: 'passthrough',
        video: { height: 720, width: 1280, codec: 'h264' },
      },
      source: { camStreamId: 'native:main', kind: 'cam-stream' },
      deviceId: 101,
    }
    expect(egressTranscodeSharingKey(a)).toBe(egressTranscodeSharingKey(b))
  })

  it('applies defaults before hashing — an omitted field and its default share', () => {
    const omitted = request()
    const explicit = request({ rateControl: 'relaxed' })
    expect(egressTranscodeSharingKey(omitted)).toBe(egressTranscodeSharingKey(explicit))
  })

  it('separates requests that differ in ANY encode field', () => {
    const base = egressTranscodeSharingKey(request())
    const variants: readonly EgressTranscodeRequest[] = [
      request({ deviceId: 102 }),
      request({ source: { kind: 'profile', profile: 'low' } }),
      request({ rateControl: 'tight' }),
      request({ bitstreamFilter: 'dump_extra' }),
      request({ pixelFormat: 'yuv420p' }),
      request({ decodeHwAccel: 'none' }),
      request({
        encode: {
          video: {
            codec: 'h264',
            profile: 'baseline',
            level: '3.1',
            width: 640,
            height: 360,
          },
          audio: 'passthrough',
        },
      }),
      request({
        encode: {
          video: {
            codec: 'h264',
            profile: 'baseline',
            width: 1280,
            height: 720,
          },
          audio: 'passthrough',
        },
      }),
      // A slicing choice is an ENCODER choice: a consumer that needs one slice
      // per frame (Alexa, whose depacketiser freezes on five) and one that does
      // not are asking for two different streams and must not share a child.
      request({
        encode: {
          video: {
            codec: 'h264',
            profile: 'baseline',
            level: '3.1',
            width: 1280,
            height: 720,
            singleSlicePerFrame: true,
          },
          audio: 'passthrough',
        },
      }),
    ]
    for (const v of variants) {
      expect(egressTranscodeSharingKey(v), JSON.stringify(v)).not.toBe(base)
    }
    // …and every variant is distinct from every other.
    const keys = variants.map((v) => egressTranscodeSharingKey(v))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('separates a PUSH request from a DIAL one — the transport is not shareable', () => {
    // `publishLocally` is not a delivery detail like `hostname`: a push child
    // demuxes MPEG-TS into a published cam stream and a dial child writes an
    // elementary bytestream into a restreamer. They are different processes
    // producing different containers down different transports. Excluded from
    // the key, whoever acquired FIRST decided the transport for every later
    // sharer with the same encode params — a dial consumer handed a push
    // child's url gets a url nothing ever feeds.
    const dial = egressTranscodeSharingKey(request())
    const push = egressTranscodeSharingKey(request({ publishLocally: true }))
    expect(push).not.toBe(dial)
    // An omitted `publishLocally` and an explicit `false` are the same request.
    expect(egressTranscodeSharingKey(request({ publishLocally: false }))).toBe(dial)
    expect(canonicalEgressPlan(request({ publishLocally: true })).transport).toBe('push')
    expect(canonicalEgressPlan(request()).transport).toBe('dial')
  })

  it('separates a FRAGMENTS child from the dial and push children of the same request', () => {
    // A third container down a third delivery mechanism: fragmented MP4 handed
    // to an in-process subscriber. Same encode parameters, and nothing a dial
    // or push consumer can use. Sharing one would hand a consumer a child whose
    // output it cannot read at all.
    const base = request()
    const dial = egressTranscodeSharingKey(base)
    const push = egressTranscodeSharingKey(base, { transport: 'push' })
    const frag = egressTranscodeSharingKey(base, {
      transport: 'fragments',
      fragmentMs: 4000,
    })
    expect(new Set([dial, push, frag]).size).toBe(3)
    expect(canonicalEgressPlan(base, { transport: 'fragments', fragmentMs: 4000 }).transport).toBe(
      'fragments',
    )
  })

  it('separates two fragment children that negotiated different fragment lengths', () => {
    // The length is a muxer setting (`-min_frag_duration`) and a key-frame grid
    // (`-force_key_frames`), so the two children cut media differently. A
    // consumer that negotiated 4 s and received 8 s fragments would time out
    // waiting for a boundary that never comes.
    const base = request()
    const four = egressTranscodeSharingKey(base, {
      transport: 'fragments',
      fragmentMs: 4000,
    })
    const eight = egressTranscodeSharingKey(base, {
      transport: 'fragments',
      fragmentMs: 8000,
    })
    expect(four).not.toBe(eight)
    // …and two consumers that negotiated the SAME length still share one child.
    expect(
      egressTranscodeSharingKey(base, {
        transport: 'fragments',
        fragmentMs: 4000,
      }),
    ).toBe(four)
  })

  it('a CAP request can never describe the fragments transport', () => {
    // The `fragments` transport has no request-schema surface: its consumers
    // are in-process and hold a plane object, not a url. Reachable from the cap
    // path, an unaware caller could be handed a child whose bytes never reach it.
    for (const r of [
      request(),
      request({ publishLocally: true }),
      request({ publishLocally: false }),
    ]) {
      expect(egressTransportFromRequest(r).transport).not.toBe('fragments')
      expect(egressTransportFromRequest(r).fragmentMs).toBeUndefined()
    }
  })

  it('IGNORES the fields that are not part of what is encoded', () => {
    // `tag` is attribution for the broker panel; `hostname` only rewrites the
    // DIAL address of a restreamer that is the same object either way. Folding
    // either into the key would fork the child per consumer, which is exactly
    // the sharing failure this method exists to avoid.
    const base = egressTranscodeSharingKey(request())
    expect(egressTranscodeSharingKey(request({ tag: 'alexa/sess-1' }))).toBe(base)
    expect(egressTranscodeSharingKey(request({ hostname: '10.0.0.9' }))).toBe(base)
  })

  it('does NOT merge nearly-identical requests (no quantised ladder)', () => {
    const a = request({
      encode: {
        video: { codec: 'h264', width: 1280, height: 720 },
        audio: 'passthrough',
      },
    })
    const b = request({
      encode: {
        video: { codec: 'h264', width: 1282, height: 720 },
        audio: 'passthrough',
      },
    })
    expect(egressTranscodeSharingKey(a)).not.toBe(egressTranscodeSharingKey(b))
  })
})
