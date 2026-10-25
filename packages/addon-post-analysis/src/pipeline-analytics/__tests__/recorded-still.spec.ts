import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRecordedStillArgs,
  type RecordedGop,
  type RecordedStillPorts,
  RecordedStillService,
  stillSeekSec,
} from '../recorded-still.js'

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const GOP: RecordedGop = {
  data: new Uint8Array([1, 2, 3]),
  gopStartMs: 1_000_000,
  gopDurMs: 4000,
}

function ports(overrides: Partial<RecordedStillPorts> = {}): RecordedStillPorts {
  return {
    logger: makeLogger(),
    resolveProfile: vi.fn().mockResolvedValue('high'),
    locate: vi.fn().mockResolvedValue({ startMs: 999_000 }),
    readGop: vi.fn().mockResolvedValue(GOP),
    decodeStill: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
    ...overrides,
  }
}

describe('stillSeekSec', () => {
  it('is the offset of the instant inside its own GOP', () => {
    expect(stillSeekSec(1_001_500, GOP)).toBeCloseTo(1.5)
  })

  it('clamps into the fragment rather than seeking past its end', () => {
    expect(stillSeekSec(1_099_000, GOP)).toBeCloseTo(3.999)
    expect(stillSeekSec(900_000, GOP)).toBe(0)
  })
})

describe('buildRecordedStillArgs', () => {
  // An input seek on a non-seekable pipe is unreliable; the fragment is ONE
  // GOP, so the usual cost of an output seek does not apply.
  it('seeks AFTER the input, because the input is a pipe', () => {
    const args = buildRecordedStillArgs(1.5, 1920)
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'))
    expect(args).toContain('pipe:0')
    expect(args.at(-1)).toBe('pipe:1')
  })

  it('caps the width without ever upscaling a smaller source', () => {
    expect(buildRecordedStillArgs(0, 1920)).toContain("scale='min(1920,iw)':-2")
  })

  it('never emits a negative seek', () => {
    expect(buildRecordedStillArgs(-4, 1920)).toContain('0')
  })
})

describe('RecordedStillService', () => {
  it('recovers a frame when footage covers the instant', async () => {
    const svc = new RecordedStillService(ports())
    const res = await svc.recover(101, 1_001_500, 1920)
    expect(res.outcome).toBe('ok')
    expect(res.jpeg?.byteLength).toBe(2)
    expect(res.gopStartMs).toBe(1_000_000)
  })

  // The four refusals have four different fixes and one of them is "nothing,
  // this is expected". A single null made the 21.7% unattributable once.
  it('reports NO-RECORDING without reading a byte of disk', async () => {
    const readGop = vi.fn()
    const svc = new RecordedStillService(
      ports({ resolveProfile: vi.fn().mockResolvedValue(null), readGop }),
    )
    expect((await svc.recover(101, 1, 1920)).outcome).toBe('no-recording')
    expect(readGop).not.toHaveBeenCalled()
  })

  it('reports NO-FOOTAGE for a gap, and does not read the GOP', async () => {
    const readGop = vi.fn()
    const svc = new RecordedStillService(
      ports({ locate: vi.fn().mockResolvedValue(null), readGop }),
    )
    expect((await svc.recover(101, 1, 1920)).outcome).toBe('no-footage')
    expect(readGop).not.toHaveBeenCalled()
  })

  it('reports DECODE-FAILED when the bytes were there and the decode was not', async () => {
    const svc = new RecordedStillService(ports({ decodeStill: vi.fn().mockResolvedValue(null) }))
    expect((await svc.recover(101, 1, 1920)).outcome).toBe('decode-failed')
  })

  it('turns a thrown port into an outcome — a maintenance pass never dies on one track', async () => {
    const svc = new RecordedStillService(
      ports({ readGop: vi.fn().mockRejectedValue(new Error('EIO')) }),
    )
    expect((await svc.recover(101, 1, 1920)).outcome).toBe('decode-failed')
  })

  it('REFUSES past its concurrency bound instead of queueing work whose value decays', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const svc = new RecordedStillService(
      ports({
        decodeStill: vi.fn().mockImplementation(async () => {
          await gate
          return Buffer.from([1])
        }),
      }),
      1,
    )
    const first = svc.recover(101, 1, 1920)
    await Promise.resolve()
    expect(svc.running).toBe(1)
    expect((await svc.recover(101, 2, 1920)).outcome).toBe('busy')
    release?.()
    expect((await first).outcome).toBe('ok')
    expect(svc.running).toBe(0)
  })

  // The operator's hard condition, 2026-08-13: a notification never waits on a
  // GOP decode. The STRUCTURAL half is
  // `scripts/check-recorded-still-off-delivery-path.ts` (no delivery module may
  // import this one); this is the behavioural half — a recovery in flight holds
  // no lock, no queue and no shared resource that a delivery could block on, so
  // a delivery started after it still completes first.
  it('a delivery completes while a recovery is still decoding', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const svc = new RecordedStillService(
      ports({
        decodeStill: vi.fn().mockImplementation(async () => {
          await gate
          return Buffer.from([1])
        }),
      }),
    )
    const order: string[] = []
    const recovery = svc.recover(101, 1, 1920).then(() => order.push('recovery'))
    await Promise.resolve()
    expect(svc.running).toBe(1)

    // Something a notification actually does while that decode is pending.
    const delivery = Promise.resolve().then(() => order.push('delivery'))
    await delivery

    expect(order).toEqual(['delivery'])
    release?.()
    await recovery
    expect(order).toEqual(['delivery', 'recovery'])
  })

  it('gives its slot back on every exit path, including a failure', async () => {
    const svc = new RecordedStillService(
      ports({ decodeStill: vi.fn().mockRejectedValue(new Error('boom')) }),
      1,
    )
    await svc.recover(101, 1, 1920)
    expect(svc.running).toBe(0)
    // The slot is usable again.
    expect((await new RecordedStillService(ports(), 1).recover(101, 1, 1920)).outcome).toBe('ok')
  })
})
