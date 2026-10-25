/**
 * The controller's Receiver Reports, read from real bytes.
 *
 * `CLAUDE.md` records that this repo has twice shipped a green test that
 * agreed with the bug, because the fake supplied the value production forgot
 * to fetch. A parser tested against objects a helper invented would do exactly
 * that, so every buffer below is either written out byte by byte in RFC 3550
 * §6.4 layout, or produced by `werift-rtp`'s own serialiser — an
 * implementation that shares no code with the parser under test. The two are
 * asserted to agree, so a wrong field offset cannot pass.
 */
import { describe, expect, it } from 'vitest'
import {
  ProtectionProfileAes128CmHmacSha1_80,
  RtcpReceiverInfo,
  RtcpRrPacket,
  SrtcpSession,
} from 'werift-rtp'

import {
  applyReceiverReportBlock,
  emptyReceiverReportTally,
  ingestDecryptedRtcp,
  parseCompoundRtcp,
  recordUnreadableRtcp,
  type ReceiverReportBlock,
} from '../rtcp-receiver-report.js'

const hex = (text: string): Buffer => Buffer.from(text.replace(/\s+/g, ''), 'hex')

/**
 * One Receiver Report, RC=1, written out field by field.
 *
 *   81       V=2, P=0, RC=1
 *   c9       PT=201 (RR)
 *   0007     length = 7 words + 1 => 32 bytes
 *   deadbeef SSRC of the reporter (the controller)
 *   -- report block --
 *   12345678 SSRC_1: the stream WE sent
 *   40       fraction lost = 64/256 = 25.0 %
 *   000123   cumulative packets lost = 291
 *   0000c0de extended highest sequence received = 49374
 *   000002bc interarrival jitter = 700
 *   aabbccdd last SR timestamp
 *   00008000 delay since last SR = 32768/65536 s = 500 ms
 */
const RR_ONE_BLOCK = hex(`
  81 c9 0007
  deadbeef
  12345678 40 000123 0000c0de 000002bc aabbccdd 00008000
`)

/** RR with a reception-report count of zero — legal, and what a controller sends before it has received anything. */
const RR_NO_BLOCKS = hex(`
  80 c9 0001
  deadbeef
`)

/**
 * Source Description, PT=202, one chunk with a CNAME item. Present only so the
 * traversal has to step OVER a packet it does not care about to reach the RR
 * behind it — exactly the compound shape iOS sends.
 */
const SDES = hex(`
  81 ca 0003
  11223344
  01 02 6869 00 00 00 00
`)

describe('parseCompoundRtcp — a single Receiver Report', () => {
  it('reads every field the two cause families are told apart by', () => {
    const result = parseCompoundRtcp(RR_ONE_BLOCK)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.packetTypes).toEqual([201])
    expect(result.reports).toHaveLength(1)

    const report = result.reports[0]!
    expect(report.packetType).toBe(201)
    expect(report.reporterSsrc).toBe(0xdeadbeef)
    expect(report.blocks).toHaveLength(1)

    expect(report.blocks[0]).toEqual({
      aboutSsrc: 0x12345678,
      fractionLostRaw: 0x40,
      fractionLostPct: 25,
      cumulativePacketsLost: 291,
      extendedHighestSequence: 49374,
      jitter: 700,
      lastSrTimestamp: 0xaabbccdd,
      delaySinceLastSrMs: 500,
    })
  })

  it('agrees byte for byte with an independent RTCP serialiser', () => {
    // werift-rtp shares no code with the parser under test. If either side has
    // a field at the wrong offset, these two disagree.
    const serialised = new RtcpRrPacket({
      ssrc: 0xdeadbeef,
      reports: [
        new RtcpReceiverInfo({
          ssrc: 0x12345678,
          fractionLost: 0x40,
          packetsLost: 291,
          highestSequence: 49374,
          jitter: 700,
          lsr: 0xaabbccdd,
          dlsr: 0x8000,
        }),
      ],
    }).serialize()

    expect(serialised.equals(RR_ONE_BLOCK)).toBe(true)

    const result = parseCompoundRtcp(serialised)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reports[0]?.blocks[0]?.extendedHighestSequence).toBe(49374)
  })

  it('reads cumulative packets lost as SIGNED — duplicates make it negative', () => {
    // 0xffffff is -1, not 16 777 215. Reading it unsigned would report a
    // catastrophic loss for a stream that in fact delivered a duplicate.
    const block = hex(`
      81 c9 0007
      deadbeef
      12345678 00 ffffff 0000c0de 00000000 00000000 00000000
    `)
    const result = parseCompoundRtcp(block)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reports[0]?.blocks[0]?.cumulativePacketsLost).toBe(-1)
  })

  it('derives the loss percentage from the raw 8-bit fixed point field', () => {
    const total = hex(`
      81 c9 0007
      deadbeef
      12345678 ff 000000 00000000 00000000 00000000 00000000
    `)
    const none = hex(`
      81 c9 0007
      deadbeef
      12345678 00 000000 00000000 00000000 00000000 00000000
    `)

    const lossy = parseCompoundRtcp(total)
    const clean = parseCompoundRtcp(none)
    expect(lossy.ok).toBe(true)
    expect(clean.ok).toBe(true)
    if (!lossy.ok || !clean.ok) return
    // 255/256 = 99.609…, reported to one decimal.
    expect(lossy.reports[0]?.blocks[0]?.fractionLostPct).toBe(99.6)
    expect(clean.reports[0]?.blocks[0]?.fractionLostPct).toBe(0)
  })
})

describe('parseCompoundRtcp — shapes that must not be mistaken for silence', () => {
  it('finds a Receiver Report bundled behind an SDES', () => {
    const result = parseCompoundRtcp(Buffer.concat([SDES, RR_ONE_BLOCK]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.packetTypes).toEqual([202, 201])
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]?.blocks[0]?.aboutSsrc).toBe(0x12345678)
  })

  it('accepts a Receiver Report with zero report blocks', () => {
    const result = parseCompoundRtcp(RR_NO_BLOCKS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]?.reporterSsrc).toBe(0xdeadbeef)
    expect(result.reports[0]?.blocks).toEqual([])
  })

  it('reads report blocks attached to a Sender Report, skipping the sender info', () => {
    //  81 c8 000c  V=2 RC=1 PT=200 length=12 => 52 bytes
    //  cafebabe    reporter SSRC
    //  <20 bytes>  NTP(8) + RTP ts(4) + packet count(4) + octet count(4)
    //  <24 bytes>  the report block, at the SAME layout as in an RR
    const sr = hex(`
      81 c8 000c
      cafebabe
      0000000000000000 00000000 00000000 00000000
      12345678 20 000005 000003e8 0000000a 00000000 00010000
    `)
    const result = parseCompoundRtcp(sr)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reports[0]?.packetType).toBe(200)
    expect(result.reports[0]?.reporterSsrc).toBe(0xcafebabe)
    expect(result.reports[0]?.blocks[0]?.cumulativePacketsLost).toBe(5)
    expect(result.reports[0]?.blocks[0]?.extendedHighestSequence).toBe(1000)
    expect(result.reports[0]?.blocks[0]?.delaySinceLastSrMs).toBe(1000)
  })
})

describe('parseCompoundRtcp — malformed input is named, never thrown', () => {
  it('rejects an empty datagram', () => {
    expect(parseCompoundRtcp(Buffer.alloc(0))).toEqual({
      ok: false,
      failure: 'empty',
      atOffset: 0,
    })
  })

  it('rejects a runt that cannot hold a header', () => {
    expect(parseCompoundRtcp(hex('81 c9 00'))).toMatchObject({ failure: 'short-header' })
  })

  it('rejects a packet whose version is not 2 — the tell for a bad decrypt', () => {
    expect(parseCompoundRtcp(hex('01 c9 0007 deadbeef'))).toMatchObject({ failure: 'bad-version' })
  })

  it('rejects a declared length that runs past the buffer', () => {
    // Header says 32 bytes; only 8 are present.
    expect(parseCompoundRtcp(hex('81 c9 0007 deadbeef'))).toMatchObject({
      failure: 'length-overrun',
      atOffset: 0,
    })
  })

  it('rejects a report count larger than the body it declares', () => {
    // RC=2 needs 4 + 4 + 48 = 56 bytes, the length field declares 32.
    const truncated = Buffer.concat([RR_ONE_BLOCK])
    truncated[0] = 0x82
    expect(parseCompoundRtcp(truncated)).toMatchObject({ failure: 'truncated-body' })
  })

  it('locates the failure inside a compound packet', () => {
    const result = parseCompoundRtcp(Buffer.concat([SDES, hex('01 c9 0007 deadbeef')]))
    expect(result).toMatchObject({ failure: 'bad-version', atOffset: SDES.length })
  })
})

const BLOCK: ReceiverReportBlock = {
  aboutSsrc: 1,
  fractionLostRaw: 0,
  fractionLostPct: 0,
  cumulativePacketsLost: 0,
  extendedHighestSequence: 100,
  jitter: 10,
  lastSrTimestamp: 0,
  delaySinceLastSrMs: 0,
}

describe('ReceiverReportTally', () => {
  it('keeps last and worst apart — a start-up transient must not hide the steady state', () => {
    let tally = emptyReceiverReportTally()
    tally = applyReceiverReportBlock(tally, { ...BLOCK, fractionLostPct: 40, jitter: 900 })
    tally = applyReceiverReportBlock(tally, { ...BLOCK, fractionLostPct: 0.4, jitter: 120 })

    expect(tally.lastFractionLostPct).toBe(0.4)
    expect(tally.worstFractionLostPct).toBe(40)
    expect(tally.lastJitter).toBe(120)
    expect(tally.maxJitter).toBe(900)
    expect(tally.blocksParsed).toBe(2)
  })

  it('does not mutate the tally it is given', () => {
    const before = emptyReceiverReportTally()
    const after = applyReceiverReportBlock(before, BLOCK)

    expect(before.blocksParsed).toBe(0)
    expect(before.lastJitter).toBeNull()
    expect(after).not.toBe(before)
  })

  it('starts with nulls, not zeroes — "no report" must not read as "zero loss"', () => {
    const tally = emptyReceiverReportTally()
    expect(tally.lastFractionLostPct).toBeNull()
    expect(tally.lastCumulativePacketsLost).toBeNull()
    expect(tally.reportsParsed).toBe(0)
  })

  it('counts an unreadable datagram', () => {
    expect(recordUnreadableRtcp(emptyReceiverReportTally()).unreadable).toBe(1)
  })
})

describe('ingestDecryptedRtcp', () => {
  it('folds a real Receiver Report into the tally and returns it', () => {
    const outcome = ingestDecryptedRtcp(RR_ONE_BLOCK, emptyReceiverReportTally())

    expect(outcome.failure).toBeNull()
    expect(outcome.reports).toHaveLength(1)
    expect(outcome.tally.reportsParsed).toBe(1)
    expect(outcome.tally.blocksParsed).toBe(1)
    expect(outcome.tally.lastFractionLostPct).toBe(25)
    expect(outcome.tally.lastCumulativePacketsLost).toBe(291)
    expect(outcome.tally.lastExtendedHighestSequence).toBe(49374)
    expect(outcome.tally.lastJitter).toBe(700)
  })

  it('does not count a block-free report as a report', () => {
    const outcome = ingestDecryptedRtcp(RR_NO_BLOCKS, emptyReceiverReportTally())

    expect(outcome.failure).toBeNull()
    expect(outcome.reports).toHaveLength(1)
    expect(outcome.tally.reportsParsed).toBe(0)
    expect(outcome.tally.lastFractionLostPct).toBeNull()
  })

  it('books a malformed datagram instead of throwing on a UDP handler', () => {
    const outcome = ingestDecryptedRtcp(hex('01 c9 0007 deadbeef'), emptyReceiverReportTally())

    expect(outcome.failure).toBe('bad-version')
    expect(outcome.tally.unreadable).toBe(1)
    expect(outcome.tally.reportsParsed).toBe(0)
  })

  /**
   * The delegate never sees plaintext on the wire: the controller's report
   * arrives SRTCP-encrypted and is decrypted by a context built from the HAP
   * master key. This exercises that seam with the SAME library and profile
   * production uses, so a key/profile mismatch or a wrong direction on the
   * context fails here rather than on the hub.
   *
   * It cannot prove that iOS keys its RTCP the way this assumes — that is a
   * property of HAP, verifiable only against a real controller.
   */
  it('reads a report that arrived SRTCP-encrypted, as the delegate does', () => {
    const key = Buffer.alloc(16, 7)
    const salt = Buffer.alloc(14, 3)
    const config = {
      keys: {
        localMasterKey: key,
        localMasterSalt: salt,
        remoteMasterKey: key,
        remoteMasterSalt: salt,
      },
      profile: ProtectionProfileAes128CmHmacSha1_80,
    }
    // Two contexts, as production has: one stands in for the controller, one is
    // the delegate's inbound context.
    const controller = new SrtcpSession(config)
    const inbound = new SrtcpSession(config)

    const onTheWire = controller.encrypt(RR_ONE_BLOCK)
    expect(onTheWire.equals(RR_ONE_BLOCK)).toBe(false)

    const outcome = ingestDecryptedRtcp(inbound.decrypt(onTheWire), emptyReceiverReportTally())
    expect(outcome.failure).toBeNull()
    expect(outcome.tally.lastFractionLostPct).toBe(25)
    expect(outcome.tally.lastCumulativePacketsLost).toBe(291)
  })

  it('accumulates across the datagrams of one session', () => {
    let tally = emptyReceiverReportTally()
    tally = ingestDecryptedRtcp(RR_ONE_BLOCK, tally).tally
    tally = ingestDecryptedRtcp(Buffer.concat([SDES, RR_ONE_BLOCK]), tally).tally

    expect(tally.reportsParsed).toBe(2)
    expect(tally.blocksParsed).toBe(2)
    expect(tally.worstFractionLostPct).toBe(25)
  })
})
