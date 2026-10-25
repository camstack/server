/**
 * The two bounded memos HomeKit's decode path owns, written before either
 * existed.
 *
 * Both mirror something the broker already had and HomeKit did not (D67 /
 * `docs/superpowers/specs/2026-08-07-hap-egress-primitive-migration.md`
 * Phase 0):
 *
 *  - `probeDecoderHwaccel` issued a cross-process `decoder.getInfo` per SESSION,
 *    and iOS starts sessions in bursts — one on record was started three times
 *    in 16 s.
 *  - when HomeKit's hardware child died at init and the software retry saved
 *    the session, HomeKit told NOBODY. The next session re-picked the same
 *    corpse and paid the same two-second death.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import {
  createDecoderReadingMemo,
  createHapDecodeMemos,
  decodeDecoderReading,
  encodeDecoderReading,
  HAP_DECODE_MEMO_TTL_MS,
} from '../stream-hwaccel-memo.js'
import {
  type DecoderInfoFields,
  type DecoderInfoSource,
  probeDecoderHwaccel,
} from '../stream-hwaccel-probe.js'
import type { DecoderHwaccelReading } from '../stream-hwaccel.js'

describe('the decoder reading codec', () => {
  /**
   * The shared `HwAccelCache` stores ONE `string | null`, and its three states
   * — `undefined` (expired), `null` (a remembered absence) and a string — are
   * exactly the three a reading needs. So the reading rides it through a codec
   * rather than through a second cache whose expiry could skew from the first.
   */
  it('round-trips every shape the decoder can answer with', () => {
    const cases: ReadonlyArray<DecoderHwaccelReading | null> = [
      null,
      { hwaccel: null, probedBestHwaccel: null },
      { hwaccel: 'auto', probedBestHwaccel: 'vaapi' },
      { hwaccel: 'none', probedBestHwaccel: '' },
      { hwaccel: null, probedBestHwaccel: 'videotoolbox' },
    ]
    for (const reading of cases) {
      expect(decodeDecoderReading(encodeDecoderReading(reading))).toEqual(reading)
    }
  })

  it('keeps "no reading" distinct from "a reading whose fields are empty"', () => {
    // The first means the decoder could not be reached; the second means it
    // answered and has nothing probed. They end in software for DIFFERENT named
    // reasons (`no-decoder-reading` vs `not-probed`) and must not collapse.
    expect(encodeDecoderReading(null)).toBeNull()
    expect(encodeDecoderReading({ hwaccel: null, probedBestHwaccel: null })).not.toBeNull()
  })
})

describe('createDecoderReadingMemo', () => {
  it('answers from the memo inside the window, so a burst pays ONE cap call', () => {
    let clock = 0
    const memo = createDecoderReadingMemo({ ttlMs: 60_000, now: () => clock })
    expect(memo.read()).toBeUndefined()

    memo.write({ hwaccel: 'auto', probedBestHwaccel: 'vaapi' })
    clock += 59_000
    expect(memo.read()).toEqual({ hwaccel: 'auto', probedBestHwaccel: 'vaapi' })
  })

  it('expires, so an operator who changes the decoder backend is obeyed', () => {
    let clock = 0
    const memo = createDecoderReadingMemo({ ttlMs: 60_000, now: () => clock })
    memo.write({ hwaccel: 'auto', probedBestHwaccel: 'vaapi' })
    clock += 60_001
    expect(memo.read()).toBeUndefined()
  })

  it('remembers a FAILED read too — a node with no decoder must not re-pay it', () => {
    // `undefined` (never asked / expired) and `null` (asked, nothing answered)
    // are different answers. Collapsing them would make an unreachable decoder
    // cost a cross-process call on every single session.
    let clock = 0
    const memo = createDecoderReadingMemo({ ttlMs: 60_000, now: () => clock })
    memo.write(null)
    expect(memo.read()).toBeNull()
    clock += 60_001
    expect(memo.read()).toBeUndefined()
  })
})

function silentLogger(): IScopedLogger {
  const log: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
    withTags: () => log,
  }
  return log
}

describe('probeDecoderHwaccel through the memo', () => {
  /**
   * The claim the memo makes, and the only test that can check it: three
   * sessions inside the window issue ONE `decoder.getInfo`. iOS restarts a
   * session it is not enjoying — one on record was started three times in 16 s
   * — so this is the real traffic shape, not a hypothetical one.
   */
  it('collapses a BURST of sessions to a single cap call', async () => {
    let clock = 0
    const readInfo = vi.fn(
      (): Promise<DecoderInfoFields> =>
        Promise.resolve({ hwaccel: 'auto', probedBestHwaccel: 'vaapi' }),
    )
    const source: DecoderInfoSource = { localNodeId: 'hub', readInfo }
    const memo = createDecoderReadingMemo({ ttlMs: 60_000, now: () => clock })
    const log = silentLogger()

    const first = await probeDecoderHwaccel({ source, log, memo })
    clock += 5_000
    const second = await probeDecoderHwaccel({ source, log, memo })
    clock += 5_000
    const third = await probeDecoderHwaccel({ source, log, memo })

    expect(readInfo).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ hwaccel: 'auto', probedBestHwaccel: 'vaapi' })
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('asks again once the window has passed', async () => {
    let clock = 0
    const readInfo = vi.fn(
      (): Promise<DecoderInfoFields> => Promise.resolve({ probedBestHwaccel: 'vaapi' }),
    )
    const source: DecoderInfoSource = { localNodeId: 'hub', readInfo }
    const memo = createDecoderReadingMemo({ ttlMs: 60_000, now: () => clock })

    await probeDecoderHwaccel({ source, log: silentLogger(), memo })
    clock += 60_001
    await probeDecoderHwaccel({ source, log: silentLogger(), memo })

    expect(readInfo).toHaveBeenCalledTimes(2)
  })

  it('remembers a THROWN read, so an unreachable decoder is asked once', async () => {
    let clock = 0
    const readInfo = vi.fn((): Promise<DecoderInfoFields> => Promise.reject(new Error('no route')))
    const source: DecoderInfoSource = { localNodeId: 'hub', readInfo }
    const memo = createDecoderReadingMemo({ ttlMs: 60_000, now: () => clock })

    expect(await probeDecoderHwaccel({ source, log: silentLogger(), memo })).toBeNull()
    clock += 1_000
    expect(await probeDecoderHwaccel({ source, log: silentLogger(), memo })).toBeNull()

    expect(readInfo).toHaveBeenCalledTimes(1)
  })

  it('does NOT memoise a missing local node id — that is boot order, not the host', () => {
    // Caching it would keep every session in software for a minute after the
    // kernel finished coming up.
    let clock = 0
    const readInfo = vi.fn((): Promise<DecoderInfoFields> => Promise.resolve({}))
    const memo = createDecoderReadingMemo({ ttlMs: 60_000, now: () => clock })
    const booting: DecoderInfoSource = { localNodeId: undefined, readInfo }

    return probeDecoderHwaccel({ source: booting, log: silentLogger(), memo }).then(async () => {
      expect(memo.read()).toBeUndefined()
      const ready: DecoderInfoSource = { localNodeId: 'hub', readInfo }
      await probeDecoderHwaccel({ source: ready, log: silentLogger(), memo })
      expect(readInfo).toHaveBeenCalledTimes(1)
    })
  })
})

describe('createHapDecodeMemos', () => {
  it('gives the reading and the failed backend the SAME window the broker uses', () => {
    // 60 s, matching `stream-broker-manager`'s `egressHwAccelCache`. A HomeKit
    // memo that outlived the broker's would make "did hardware come back yet"
    // answer differently depending on which consumer asked.
    expect(HAP_DECODE_MEMO_TTL_MS).toBe(60_000)
  })

  it('records the backend that died so the NEXT session skips it', () => {
    let clock = 0
    const memos = createHapDecodeMemos(() => clock)
    expect(memos.failedBackend.read() ?? null).toBeNull()

    memos.failedBackend.write('vaapi')
    expect(memos.failedBackend.read()).toBe('vaapi')

    clock += HAP_DECODE_MEMO_TTL_MS + 1
    // Expired: hardware is tried again rather than written off forever. The
    // ENOMEM that kills a vaapi device here is transient, and a permanent
    // write-off would keep decoding in software long after it cleared.
    expect(memos.failedBackend.read() ?? null).toBeNull()
  })

  it('hands out ONE instance per process, shared by every camera', () => {
    // Per-camera memos would mean camera B re-pays camera A's two-second death,
    // which is the whole gap this closes.
    const memos = createHapDecodeMemos()
    expect(memos.reading).toBeDefined()
    expect(memos.failedBackend).toBeDefined()
  })
})
