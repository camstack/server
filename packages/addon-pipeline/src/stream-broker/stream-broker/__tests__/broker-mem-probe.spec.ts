import { describe, expect, it } from 'vitest'
import {
  type BrokerMemSample,
  ConsumerChurn,
  countActiveResources,
  createLineLimiter,
  formatBrokerMem,
  formatHeapSpaces,
  readV8Heap,
  parseProcMaps,
  parseProcStatus,
  readCopyOwnedTotals,
} from '../broker-mem-probe.js'
import { copyOwned } from '../owned-buffer.js'

const MB = 1024 * 1024

const STATUS = `Name:\tnode
VmRSS:\t  900000 kB
RssAnon:\t  614400 kB
RssFile:\t   20480 kB
RssShmem:\t       0 kB
`

const MAPS = [
  '00400000-00a00000 r-xp 00000000 08:01 123 /usr/bin/node',
  '01000000-11000000 rw-p 00000000 00:00 0 [heap]',
  '7f0000000000-7f0000100000 rw-p 00000000 00:00 0 ',
  '7f0000200000-7f0000240000 rw-p 00000000 00:00 0',
  '7f0000300000-7f0000340000 rw-p 00000000 00:00 0',
  '7f0000400000-7f0000440000 rw-p 00000000 00:00 0 ',
  '7f0000500000-7f0000540000 rw-p 00000000 00:00 0 /lib/libx.so',
  '7ffc00000000-7ffc00021000 rw-p 00000000 00:00 0 [stack]',
].join('\n')

function sample(over: Partial<BrokerMemSample>): BrokerMemSample {
  return {
    deviceId: 1,
    brokerId: '1/native',
    ingesting: true,
    preBufferBytes: 0,
    clipBytes: 0,
    rtpRingBytes: 0,
    keyframeCacheBytes: 0,
    rtspSessions: 0,
    writeQueueSumBytes: 0,
    writeQueueMaxBytes: 0,
    encodedByKind: {},
    audioSubscribers: 0,
    pipeClients: 0,
    annexBPlaneActive: false,
    ...over,
  }
}

describe('parseProcStatus', () => {
  it('reads RssAnon and RssFile', () => {
    expect(parseProcStatus(STATUS)).toEqual({
      rssAnonKb: 614400,
      rssFileKb: 20480,
    })
  })
  it('is null when the fields are absent (non-Linux text)', () => {
    expect(parseProcStatus('Name: node')).toBeNull()
  })
})

describe('parseProcMaps', () => {
  it('sizes [heap] and counts path-less mappings only', () => {
    const r = parseProcMaps(MAPS)
    expect(r.heapBytes).toBe(0x10000000)
    expect(r.anonMappings).toBe(4)
    expect(r.anonBytes).toBe(0x100000 + 3 * 0x40000)
  })
  it('counts only EXACTLY 256 KB path-less mappings as V8 pages', () => {
    expect(parseProcMaps(MAPS).v8PageMaps).toBe(3)
  })
  it('tolerates empty text', () => {
    expect(parseProcMaps('')).toEqual({
      heapBytes: 0,
      anonMappings: 0,
      anonBytes: 0,
      v8PageMaps: 0,
    })
  })
})

describe('ConsumerChurn', () => {
  it('counts per kind and resets on drain', () => {
    const c = new ConsumerChurn()
    c.recordOpen('recording')
    c.recordOpen('recording')
    c.recordClose('rtsp')
    expect(c.drain()).toEqual({
      opened: 2,
      closed: 1,
      openedByKind: { recording: 2 },
      closedByKind: { rtsp: 1 },
    })
    expect(c.drain().opened).toBe(0)
  })
})

describe('createLineLimiter', () => {
  it('admits up to the cap per window and reports what it swallowed', () => {
    const admit = createLineLimiter(2, 1000)
    expect(admit(0).admit).toBe(true)
    expect(admit(10).admit).toBe(true)
    expect(admit(20).admit).toBe(false)
    expect(admit(30).admit).toBe(false)
    expect(admit(1001)).toEqual({ admit: true, suppressedBefore: 2 })
  })
})

describe('copyOwned counters', () => {
  it('adds one packet and its length per copy, and owns its store', () => {
    const before = readCopyOwnedTotals()
    const src = Buffer.from([1, 2, 3, 4, 5, 6])
    const out = copyOwned(src, 1, 4)
    const after = readCopyOwnedTotals()
    expect(after.packets - before.packets).toBe(1)
    expect(after.bytes - before.bytes).toBe(3)
    expect([...out]).toEqual([2, 3, 4])
  })
})

describe('formatBrokerMem', () => {
  const base = {
    webrtcSessions: 2,
    egressTranscodes: 1,
    childProcesses: 3,
    proc: {
      status: { rssAnonKb: 614400, rssFileKb: 20480 },
      maps: parseProcMaps(MAPS),
    },
    churn: {
      opened: 4,
      closed: 3,
      openedByKind: { rtsp: 4 },
      closedByKind: { rtsp: 3 },
    },
    copied: { packets: 10, bytes: 5 * MB },
  }

  it('aggregates rings, queues, consumers and keeps the top 5 cameras', () => {
    const samples = [
      sample({
        deviceId: 1,
        preBufferBytes: 1 * MB,
        rtspSessions: 1,
        writeQueueSumBytes: 2 * MB,
        writeQueueMaxBytes: 2 * MB,
        encodedByKind: { recording: 1 },
      }),
      sample({
        deviceId: 2,
        rtpRingBytes: 8 * MB,
        writeQueueSumBytes: 5 * MB,
        writeQueueMaxBytes: 5 * MB,
        annexBPlaneActive: true,
        encodedByKind: { recording: 1, pipeline: 2 },
      }),
      sample({ deviceId: 3, clipBytes: 3 * MB, ingesting: false }),
      sample({ deviceId: 4 }),
      sample({ deviceId: 5 }),
      sample({ deviceId: 6 }),
    ]
    const line = formatBrokerMem({ ...base, samples })
    expect(
      line.startsWith('[broker-mem] rssAnonMb=600 rssFileMb=20 heapMapMb=256.0 anonMaps=4'),
    ).toBe(true)
    expect(line).toContain('brokers=6 ingesting=5 annexBPlanes=1 rtsp=1 webrtc=2')
    expect(line).toContain('encoded=pipeline:2,recording:2')
    expect(line).toContain('preBufferMb=1.0 clipMb=3.0 rtpRingMb=8.0')
    expect(line).toContain('writeQueueSumMb=7.0 writeQueueMaxMb=5.0')
    expect(line).toContain('copiedPackets=10 copiedMb=5.0')
    expect(line).toContain('topRingMb=2:8.0,3:3.0,1:1.0,4:0.0,5:0.0')
    expect(line.includes('\n')).toBe(false)
  })

  it('omits the native view when /proc is unavailable', () => {
    const line = formatBrokerMem({
      ...base,
      proc: { status: null, maps: null },
      samples: [],
    })
    expect(line).not.toContain('rssAnonMb')
    expect(line).toContain('brokers=0')
    expect(line).toContain('topRingMb=none')
  })
})

describe('V8 and worker fields', () => {
  const base = {
    webrtcSessions: 0,
    egressTranscodes: 0,
    childProcesses: 0,
    proc: { status: null, maps: parseProcMaps(MAPS) },
    churn: { opened: 0, closed: 0, openedByKind: {}, closedByKind: {} },
    copied: { packets: 0, bytes: 0 },
    samples: [],
  }
  const v8 = {
    totalHeapBytes: 105 * MB,
    physicalBytes: 98 * MB,
    mallocedBytes: 3 * MB,
    peakMallocedBytes: 9 * MB,
    externalBytes: 12 * MB,
    spaces: [
      { name: 'old_space', committedBytes: 120 * MB },
      { name: 'new_space', committedBytes: 24 * MB },
      { name: 'large_object_space', committedBytes: 8 * MB },
      { name: 'map_space', committedBytes: 0 },
      { name: 'mystery_space', committedBytes: 1 * MB },
    ],
  }

  it('formats v8, spaces, page maps and worker fields', () => {
    const line = formatBrokerMem({
      ...base,
      v8,
      worker: {
        workers: 1,
        heapBytes: 40 * MB,
        physicalBytes: 38 * MB,
        usedBytes: 30 * MB,
        maxAgeMs: 90_400,
        idleTerminates: true,
      },
    })
    expect(line).toContain('v8PageMaps=3')
    expect(line).toContain(
      'v8TotalHeapMb=105.0 v8PhysicalMb=98.0 v8MallocedMb=3.0 v8PeakMallocedMb=9.0 v8ExternalMb=12.0',
    )
    expect(line).toContain('spaces=old:120,new:24,lo:8,mystery_space:1')
    expect(line).toContain(
      'workers=1 workerHeapMb=40.0 workerPhysicalMb=38.0 workerUsedMb=30.0 workerAgeS=90 workerIdleExit=yes',
    )
  })

  it('omits both groups when not supplied, and says none for empty spaces', () => {
    const line = formatBrokerMem(base)
    expect(line).not.toContain('v8TotalHeapMb')
    expect(line).not.toContain('workers=')
    expect(formatHeapSpaces([])).toBe('none')
  })

  it('readV8Heap reads this isolate', () => {
    const r = readV8Heap()
    expect(r.totalHeapBytes).toBeGreaterThan(0)
    expect(r.spaces.some((x) => x.name === 'old_space')).toBe(true)
  })
})

describe('packet slab fields', () => {
  const base = {
    webrtcSessions: 0,
    egressTranscodes: 0,
    childProcesses: 0,
    proc: { status: null, maps: null },
    churn: { opened: 0, closed: 0, openedByKind: {}, closedByKind: {} },
    copied: { packets: 0, bytes: 0 },
    samples: [],
  }

  it('prints the slabs in service / free and the allocations since the last line', () => {
    const line = formatBrokerMem({ ...base, slabs: { live: 41, free: 2, allocsDelta: 3 } })
    expect(line).toContain('slabs=41/2')
    expect(line).toContain('slabAllocs=3')
  })

  it('omits the group when the caller does not read it', () => {
    const line = formatBrokerMem(base)
    expect(line).not.toContain('slabs=')
    expect(line).not.toContain('slabAllocs=')
  })
})

describe('countActiveResources', () => {
  it('counts exact names', () => {
    expect(countActiveResources(['ProcessWrap', 'Timeout', 'ProcessWrap'], 'ProcessWrap')).toBe(2)
  })
})
