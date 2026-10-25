/**
 * The controller's own verdict on what we sent it.
 *
 * Every session on record ends with the controller asking us to stop, and for
 * a year the only thing observable about the return path was that packets
 * arrived. The 2026-08-06 telemetry proved iOS DOES send us RTCP on the video
 * leg (21 and 34 packets in two sessions, the gate opening on a real
 * controller packet at ~550 ms) — but counting them says nothing about what
 * they contain, and what they contain is the answer.
 *
 * Inside a Receiver Report iOS states, in its own words, how much of our
 * stream it received: `fraction lost`, `cumulative number of packets lost`,
 * `extended highest sequence number received` and `interarrival jitter`. That
 * single datum splits the remaining causes into two DISJOINT families, which
 * is the whole reason this module exists:
 *
 *   - **loss high / near-total** — the packets arrive damaged or unusable.
 *     SRTP, packetisation, MTU, sequencing. A transmit-side defect, and
 *     everything downstream of the wire is irrelevant.
 *   - **loss ~ zero** — iOS receives everything intact and still renders
 *     nothing. A decode-side problem: parameter sets, profile/level,
 *     timestamps, RTP marker/timestamp pacing.
 *
 * Nothing here decrypts: the caller owns the SRTCP context and hands us
 * plaintext. Everything is pure so the byte-level parse can be asserted
 * against hand-built RFC 3550 buffers rather than trusted.
 *
 * Why not `werift-rtp`'s `RtcpPacketConverter`, which this package already
 * depends on:
 *   - it swallows a malformed sub-packet into a debug log and returns what it
 *     managed, so "we could not read what the controller said" is
 *     indistinguishable from "the controller said nothing";
 *   - it reads `cumulative number of packets lost` as UNSIGNED, and RFC 3550
 *     §6.4.1 defines it as a signed 24-bit quantity that goes negative when
 *     duplicates outnumber losses — the exact reading that would otherwise
 *     appear as a 16-million-packet loss and send the next session chasing the
 *     wrong family;
 *   - report blocks attached to a Sender Report (PT 200) are as load-bearing
 *     as those in an RR, and only the RR path is convenient there.
 *
 * The tests cross-check this parser against buffers produced by werift's own
 * serialiser, so the two implementations have to agree on the wire format.
 */

/** RTCP Sender Report. Carries report blocks too when the sender also receives. */
export const RTCP_PT_SENDER_REPORT = 200
/** RTCP Receiver Report — what a controller that only receives sends back. */
export const RTCP_PT_RECEIVER_REPORT = 201

/** V/P/RC byte + PT byte + 16-bit length. */
const RTCP_HEADER_BYTES = 4
/** SSRC of the packet sender, first field of both SR and RR bodies. */
const RTCP_SENDER_SSRC_BYTES = 4
/** NTP + RTP timestamp, packet count, octet count — present only on an SR. */
const RTCP_SENDER_INFO_BYTES = 20
/** One report block: SSRC_n, loss, highest seq, jitter, LSR, DLSR. */
const RTCP_REPORT_BLOCK_BYTES = 24
/** `fraction lost` is an 8-bit fixed-point fraction of 256. */
const FRACTION_LOST_DENOMINATOR = 256
/** `delay since last SR` counts 1/65536 of a second. */
const DLSR_UNITS_PER_SECOND = 65536
/** `cumulative number of packets lost` is a SIGNED 24-bit field. */
const SIGNED_24_SIGN_BIT = 0x800000
const SIGNED_24_MODULUS = 0x1000000

/** One report block — the controller's assessment of one synchronisation source. */
export interface ReceiverReportBlock {
  /** SSRC the block reports ON, i.e. the stream WE sent. */
  readonly aboutSsrc: number
  /** Raw 8-bit fixed-point field, kept so the derived percentage can be audited. */
  readonly fractionLostRaw: number
  /** `fractionLostRaw / 256`, as a percentage rounded to 0.1. */
  readonly fractionLostPct: number
  /** Signed: negative means the controller saw MORE packets than we counted sending. */
  readonly cumulativePacketsLost: number
  /** Extended (cycle-adjusted) highest sequence number the controller received. */
  readonly extendedHighestSequence: number
  /** Interarrival jitter, in the stream's own RTP timestamp units. */
  readonly jitter: number
  /** Middle 32 bits of the NTP timestamp of the last Sender Report we sent. */
  readonly lastSrTimestamp: number
  /** Delay between receiving that SR and emitting this report. */
  readonly delaySinceLastSrMs: number
}

/** An SR or RR that carried at least the sender SSRC, plus its report blocks. */
export interface ControllerReceiverReport {
  readonly packetType: typeof RTCP_PT_SENDER_REPORT | typeof RTCP_PT_RECEIVER_REPORT
  /** SSRC of the CONTROLLER — who is speaking. */
  readonly reporterSsrc: number
  /** Empty when the controller had nothing to report yet; that is legal RTCP. */
  readonly blocks: readonly ReceiverReportBlock[]
}

/**
 * Why a datagram could not be read. Named rather than boolean because each
 * points somewhere different: a version fault says we decrypted garbage, a
 * length overrun says the packet was cut.
 */
export type RtcpParseFailure =
  | 'empty'
  | 'short-header'
  | 'bad-version'
  | 'length-overrun'
  | 'truncated-body'

export type RtcpParseResult =
  | {
      readonly ok: true
      /** Every payload type in the compound packet, in order — SDES and friends included. */
      readonly packetTypes: readonly number[]
      readonly reports: readonly ControllerReceiverReport[]
    }
  | {
      readonly ok: false
      readonly failure: RtcpParseFailure
      /** Byte offset of the sub-packet that failed, so a compound packet can be located. */
      readonly atOffset: number
    }

function readSigned24(packet: Buffer, at: number): number {
  const raw = (packet[at]! << 16) | (packet[at + 1]! << 8) | packet[at + 2]!
  return raw >= SIGNED_24_SIGN_BIT ? raw - SIGNED_24_MODULUS : raw
}

function readReportBlock(packet: Buffer, at: number): ReceiverReportBlock {
  const fractionLostRaw = packet[at + 4]!
  const dlsr = packet.readUInt32BE(at + 20)
  return {
    aboutSsrc: packet.readUInt32BE(at),
    fractionLostRaw,
    fractionLostPct: Math.round((fractionLostRaw / FRACTION_LOST_DENOMINATOR) * 1000) / 10,
    cumulativePacketsLost: readSigned24(packet, at + 5),
    extendedHighestSequence: packet.readUInt32BE(at + 8),
    jitter: packet.readUInt32BE(at + 12),
    lastSrTimestamp: packet.readUInt32BE(at + 16),
    delaySinceLastSrMs: Math.round((dlsr / DLSR_UNITS_PER_SECOND) * 1000),
  }
}

/**
 * Walk a (possibly compound) RTCP datagram and extract every report block.
 *
 * An RR is routinely bundled behind an SDES, and a controller with nothing to
 * report yet sends an RR with a reception-report count of zero. Both are
 * normal; neither is a failure. What IS a failure is a packet whose declared
 * length runs past the buffer or whose report count exceeds its own body —
 * those get named so a decrypt fault cannot masquerade as silence.
 */
export function parseCompoundRtcp(packet: Buffer): RtcpParseResult {
  if (packet.length === 0) return { ok: false, failure: 'empty', atOffset: 0 }

  const packetTypes: number[] = []
  const reports: ControllerReceiverReport[] = []
  let offset = 0

  while (offset < packet.length) {
    if (packet.length - offset < RTCP_HEADER_BYTES) {
      return { ok: false, failure: 'short-header', atOffset: offset }
    }
    const firstByte = packet[offset]!
    if (((firstByte >> 6) & 0x03) !== 2) {
      return { ok: false, failure: 'bad-version', atOffset: offset }
    }
    const reportCount = firstByte & 0x1f
    const packetType = packet[offset + 1]!
    // RFC 3550 §6.4.1: `length` is the packet size in 32-bit words MINUS one,
    // so the header's own word is included in the total below.
    const totalBytes = (packet.readUInt16BE(offset + 2) + 1) * 4
    if (offset + totalBytes > packet.length) {
      return { ok: false, failure: 'length-overrun', atOffset: offset }
    }
    packetTypes.push(packetType)

    if (packetType === RTCP_PT_RECEIVER_REPORT || packetType === RTCP_PT_SENDER_REPORT) {
      const senderSsrcAt = offset + RTCP_HEADER_BYTES
      const blocksAt =
        senderSsrcAt +
        RTCP_SENDER_SSRC_BYTES +
        (packetType === RTCP_PT_SENDER_REPORT ? RTCP_SENDER_INFO_BYTES : 0)
      if (blocksAt + reportCount * RTCP_REPORT_BLOCK_BYTES > offset + totalBytes) {
        return { ok: false, failure: 'truncated-body', atOffset: offset }
      }
      const blocks: ReceiverReportBlock[] = []
      for (let index = 0; index < reportCount; index += 1) {
        blocks.push(readReportBlock(packet, blocksAt + index * RTCP_REPORT_BLOCK_BYTES))
      }
      reports.push({
        packetType,
        reporterSsrc: packet.readUInt32BE(senderSsrcAt),
        blocks,
      })
    }

    offset += totalBytes
  }

  return { ok: true, packetTypes, reports }
}

/**
 * Running per-leg roll-up of everything the controller has told us.
 *
 * `last*` answers "what does iOS think right now"; `worst*`/`max*` survive the
 * transient at stream start, where a slow first key frame reliably produces one
 * lossy report that would otherwise be the only one a summary showed.
 *
 * Immutable for the same reason `DropCounters` is: a shared mutable tally is
 * how a "zero loss" reading survives a live bug.
 */
export interface ReceiverReportTally {
  /** RTCP packets that parsed and carried at least one report block. */
  readonly reportsParsed: number
  /** Individual report blocks folded in. */
  readonly blocksParsed: number
  /** RTCP that arrived but could not be decrypted or parsed. Never silent. */
  readonly unreadable: number
  readonly lastFractionLostPct: number | null
  readonly worstFractionLostPct: number | null
  readonly lastCumulativePacketsLost: number | null
  readonly maxCumulativePacketsLost: number | null
  readonly lastJitter: number | null
  readonly maxJitter: number | null
  readonly lastExtendedHighestSequence: number | null
}

export function emptyReceiverReportTally(): ReceiverReportTally {
  return {
    reportsParsed: 0,
    blocksParsed: 0,
    unreadable: 0,
    lastFractionLostPct: null,
    worstFractionLostPct: null,
    lastCumulativePacketsLost: null,
    maxCumulativePacketsLost: null,
    lastJitter: null,
    maxJitter: null,
    lastExtendedHighestSequence: null,
  }
}

function maxOrValue(previous: number | null, next: number): number {
  return previous === null ? next : Math.max(previous, next)
}

/** Fold one report block into the tally. Returns a new tally. */
export function applyReceiverReportBlock(
  tally: ReceiverReportTally,
  block: ReceiverReportBlock,
): ReceiverReportTally {
  return {
    ...tally,
    blocksParsed: tally.blocksParsed + 1,
    lastFractionLostPct: block.fractionLostPct,
    worstFractionLostPct: maxOrValue(tally.worstFractionLostPct, block.fractionLostPct),
    lastCumulativePacketsLost: block.cumulativePacketsLost,
    maxCumulativePacketsLost: maxOrValue(
      tally.maxCumulativePacketsLost,
      block.cumulativePacketsLost,
    ),
    lastJitter: block.jitter,
    maxJitter: maxOrValue(tally.maxJitter, block.jitter),
    lastExtendedHighestSequence: block.extendedHighestSequence,
  }
}

/** Book an RTCP datagram we could not read. Counted, never discarded silently. */
export function recordUnreadableRtcp(tally: ReceiverReportTally): ReceiverReportTally {
  return { ...tally, unreadable: tally.unreadable + 1 }
}

export interface RtcpIngestOutcome {
  readonly tally: ReceiverReportTally
  /** Reports found in this datagram — empty on failure, and on a report-free compound. */
  readonly reports: readonly ControllerReceiverReport[]
  /** Null when the datagram parsed; the named fault otherwise. */
  readonly failure: RtcpParseFailure | null
}

/**
 * Parse one decrypted RTCP datagram and fold it into a leg's tally.
 *
 * This is the seam the delegate calls: it owns SRTCP decryption and logging,
 * this owns everything that can be asserted from bytes alone. A malformed
 * packet returns a failure and an incremented `unreadable` — it never throws,
 * because this runs on a UDP `message` handler where a throw would take the
 * session with it.
 */
export function ingestDecryptedRtcp(
  plaintext: Buffer,
  tally: ReceiverReportTally,
): RtcpIngestOutcome {
  const parsed = parseCompoundRtcp(plaintext)
  if (!parsed.ok) {
    return { tally: recordUnreadableRtcp(tally), reports: [], failure: parsed.failure }
  }
  let next = tally
  for (const report of parsed.reports) {
    if (report.blocks.length === 0) continue
    next = { ...next, reportsParsed: next.reportsParsed + 1 }
    for (const block of report.blocks) {
      next = applyReceiverReportBlock(next, block)
    }
  }
  return { tally: next, reports: parsed.reports, failure: null }
}
