import { describe, expect, it } from 'vitest'
import { ScrubFragmentCache } from '../../recorded/scrub-fragment-cache.js'
import { PacedRtpReplay } from '../../paced-rtp-replay.js'
import { createPushFrameSource } from '../../webrtc/broker-webrtc-server.js'
import { formatBrokerMem, parseProcMaps } from '../broker-mem-probe.js'
import {
  BackingTally,
  EMPTY_BACKING_TOTALS,
  type SessionMemReading,
  sessionMemMeta,
  tallyRtpCache,
} from '../session-mem.js'

const MB = 1024 * 1024
const SLAB = 8192

/** Two views of ONE 8 KiB slab: payload 300 B, the slab 8192 B. */
function pooledPair(): [Buffer, Buffer] {
  const slab = Buffer.alloc(SLAB)
  return [slab.subarray(0, 100), slab.subarray(100, 300)]
}

function owned(n: number): Buffer {
  return Buffer.allocUnsafeSlow(n)
}

function audio(data: Buffer) {
  return { data, codec: 'Opus' as const, sampleRate: 48000, channels: 2, timestampMicros: 0 }
}

function totalsOf(bufs: readonly Buffer[]) {
  const t = new BackingTally()
  for (const b of bufs) t.add(b)
  return t.totals()
}

function reading(over: Partial<SessionMemReading>): SessionMemReading {
  return {
    sessionId: 's',
    deviceId: 1,
    rtpCache: EMPTY_BACKING_TOTALS,
    pushQueue: EMPTY_BACKING_TOTALS,
    rtpReplay: EMPTY_BACKING_TOTALS,
    scrub: EMPTY_BACKING_TOTALS,
    ...over,
  }
}

describe('BackingTally', () => {
  it('counts a shared ArrayBuffer once in the distinct sum, per entry in the naive one', () => {
    const [a, b] = pooledPair()
    const t = totalsOf([a, b, owned(1000)])
    expect(t.entries).toBe(3)
    expect(t.payloadBytes).toBe(100 + 200 + 1000)
    expect(t.naiveBackingBytes).toBe(SLAB + SLAB + 1000)
    expect(t.distinctBackingBytes).toBe(SLAB + 1000)
    expect(t.capped).toBe(false)
  })

  it('tallies a werift rtpCache, skipping empty slots, across video and audio in one tally', () => {
    const [a, b] = pooledPair()
    const tally = new BackingTally()
    tallyRtpCache(tally, [{ payload: a }, undefined, { payload: b }])
    tallyRtpCache(tally, undefined)
    tallyRtpCache(tally, [{ payload: owned(500) }])
    const t = tally.totals()
    expect(t.entries).toBe(3)
    expect(t.distinctBackingBytes).toBe(SLAB + 500)
    expect(t.naiveBackingBytes).toBe(2 * SLAB + 500)
  })
})

describe('structures feeding the tally', () => {
  it('the push queue reports its queued frames', () => {
    const { pushFrame, forEachQueued } = createPushFrameSource()
    const [a, b] = pooledPair()
    pushFrame({ type: 'audio', frame: audio(a) })
    pushFrame({ type: 'audio', frame: audio(b) })
    const tally = new BackingTally()
    forEachQueued((mf) => tally.add(mf.frame.data))
    expect(tally.totals().entries).toBe(2)
    expect(tally.totals().distinctBackingBytes).toBe(SLAB)
  })

  it('the paced replay reports its queued tail', () => {
    const replay = new PacedRtpReplay<Buffer>(
      () => true,
      () => {},
      { tuning: { singleShotMax: 0, minChunkSize: 1, maxChunkSize: 1 }, schedule: () => () => {} },
    )
    const [a, b] = pooledPair()
    replay.start([a, b, owned(100)])
    const tally = new BackingTally()
    replay.forEachQueued((p) => tally.add(p))
    // One chunk of one packet went out synchronously; the rest is queued.
    expect(tally.totals().entries).toBe(2)
    expect(tally.totals().distinctBackingBytes).toBe(SLAB + 100)
  })

  it('the scrub cache reports backing bytes next to the payload it bounds on', () => {
    const cache = new ScrubFragmentCache()
    const [a, b] = pooledPair()
    cache.put('low', {
      startMs: 0,
      durMs: 1000,
      aus: [
        { data: a, ptsMs: 0, keyframe: true, codec: 'H264' },
        { data: b, ptsMs: 40, keyframe: false, codec: 'H264' },
      ],
    })
    const tally = new BackingTally()
    cache.tallyBacking(tally)
    expect(cache.byteSize).toBe(300)
    expect(tally.totals().payloadBytes).toBe(300)
    expect(tally.totals().distinctBackingBytes).toBe(SLAB)
  })
})

describe('[broker-mem] session fields', () => {
  const base = {
    webrtcSessions: 2,
    egressTranscodes: 0,
    childProcesses: 0,
    proc: {
      status: null,
      maps: parseProcMaps('01000000-11000000 rw-p 00000000 00:00 0 [heap]'),
    },
    churn: { opened: 0, closed: 0, openedByKind: {}, closedByKind: {} },
    copied: { packets: 0, bytes: 0 },
    samples: [],
  }

  it('reports the totals, the three NACK views, fragMb and the top sessions', () => {
    const [a, b] = pooledPair()
    // Pooled NACK entries: 300 B of payload, one 8 KiB slab, the slab twice naively.
    const big = reading({
      deviceId: 101,
      rtpCache: totalsOf([a, b]),
      pushQueue: totalsOf([owned(MB)]),
      scrub: totalsOf([owned(2 * MB)]),
    })
    const small = reading({ deviceId: 102, rtpCache: totalsOf([owned(1000)]) })
    const line = formatBrokerMem({
      ...base,
      sessions: [small, big],
      arrayBuffersBytes: 600 * MB,
      v8: {
        totalHeapBytes: 0,
        physicalBytes: 0,
        mallocedBytes: 0,
        peakMallocedBytes: 0,
        externalBytes: 100 * MB,
        spaces: [],
      },
    })
    expect(line).toContain('rtpCacheEntries=3')
    expect(line).toContain('rtpCachePayloadMb=0.0')
    expect(line).toContain(`rtpCacheNaiveMb=${((2 * SLAB + 1000) / MB).toFixed(2).slice(0, 3)}`)
    expect(line).toContain('pushQueueFrames=1 pushQueueBackingMb=1.0')
    expect(line).toContain('scrubPayloadMb=2.0 scrubBackingMb=2.0')
    expect(line).toContain('arrayBuffersMb=600.0')
    // [heap] mapping 256 MB minus v8 external 100 MB.
    expect(line).toContain('fragMb=156.0')
    expect(line).toContain('topSessionMb=101:3.0,102:0.0')
    expect(line.includes('\n')).toBe(false)
  })

  it('prints a slab-pinning NACK history as backing above payload', () => {
    // 1024 packets of 100 B, each a view of its own 8 KiB slab: 0.1 MB payload
    // pinning 8 MB. This is the shape the line exists to expose.
    const pinned = Array.from({ length: 1024 }, () => Buffer.alloc(SLAB).subarray(0, 100))
    const line = formatBrokerMem({ ...base, sessions: [reading({ rtpCache: totalsOf(pinned) })] })
    expect(line).toContain('rtpCachePayloadMb=0.1 rtpCacheNaiveMb=8.0 rtpCacheBackingMb=8.0')
  })

  it('omits the group without sessions and says none for an empty top', () => {
    expect(formatBrokerMem(base)).not.toContain('rtpCacheEntries')
    expect(formatBrokerMem({ ...base, sessions: [] })).toContain('topSessionMb=none')
  })

  it('the lifecycle meta carries the same counters', () => {
    const meta = sessionMemMeta(reading({ rtpCache: totalsOf([owned(MB)]) }))
    expect(meta['rtpCacheEntries']).toBe(1)
    expect(meta['rtpCacheBackingMb']).toBe(1)
    expect(meta['sessionBackingMb']).toBe(1)
    expect(meta['memCapped']).toBe(false)
  })
})
