/**
 * delivery-meter — "did what the broker SENT land?", over at least one GOP.
 *
 * ## Why this exists (D635)
 *
 * The ladder used to judge a session on the client's receive rate in its last
 * 2 s window against an ABSOLUTE floor (128 kbps to climb, 64 to stall). That
 * measures the rung's own bitrate — DEMAND — not the link. Device 104's `low`
 * rung is ~41 kbps between IDRs with an IDR every ~4 s, so its 2 s windows
 * alternate ~250 / ~40 kbps: every P-only window reset the healthy clock and
 * the ladder never moved; a rung steadily under 64 kbps with a long GOP would
 * have confirmed a "stall" on a perfect picture.
 *
 * The question the ladder needs answered is a RATIO: of the bytes this
 * session put on the wire, how many did the client receive? A 41 kbps rung
 * that lands whole is healthy; a 3 Mbps rung that lands 60 % is not.
 *
 * ## How the two halves are aligned
 *
 * The client reports Δ bytesReceived over its own 2 s getStats window; the hub
 * stamps the report on receipt (`lastUpdated`). The broker keeps what it SENT
 * in 100 ms buckets ({@link SendHistory}), so for every client report it can
 * sum what was sent over the SAME 2 s — to the nearest bucket edge. Both sides are summed
 * over the same sub-windows, so a dropped report shortens the window without
 * skewing the ratio. A window of one 2 s report next to an IDR is noise; the
 * window therefore covers at least one GOP ({@link deliveryWindowMs}).
 *
 * Unknown is `null`, never `0` (D393): too few reports to cover a window, a
 * stale newest report, or a session too young — all say nothing.
 */

export interface DeliveryMeterConfig {
  /** How much time one client report covers (the player's getStats period). 2 000 ms. */
  readonly clientSampleSpanMs: number
  /**
   * Shortest delivery window. 2 000 ms — one client report; never less,
   * because a report is the unit the client measures in.
   */
  readonly minWindowMs: number
  /**
   * Longest delivery window. 16 000 ms — a camera with a 10 s GOP still gets
   * a whole GOP, while a stall is still judged inside the 6 s confirm plus
   * one window, not a minute later.
   */
  readonly maxWindowMs: number
  /**
   * Past this age the newest report says nothing about now. 10 000 ms — five
   * ticks, so a couple of dropped telemetry mutations do not blind the meter,
   * while a client that went away stops counting within one confirm window.
   */
  readonly maxClientSampleAgeMs: number
  /** How far back the send history reaches. 32 000 ms = 2 × `maxWindowMs`. */
  readonly historySpanMs: number
}

/** Received vs sent over the same window. */
export interface DeliveryWindow {
  /** What the client reported receiving, averaged over the window, kbps. */
  readonly receivedKbps: number
  /** What this session put on the wire over the SAME window, kbps. */
  readonly sentKbps: number
  /** The time both were summed over, ms. */
  readonly windowMs: number
}

/** The window the ladder judges delivery over: at least one GOP. */
export function deliveryWindowMs(
  idrIntervalMs: number | null,
  config: DeliveryMeterConfig,
): number {
  const gop =
    idrIntervalMs !== null && Number.isFinite(idrIntervalMs) && idrIntervalMs > 0
      ? idrIntervalMs
      : 0
  return Math.min(config.maxWindowMs, Math.max(config.minWindowMs, gop))
}

/**
 * When a session's meter may start counting client reports. A session created
 * by a tier change starts after the change blackout (review I1): until the
 * client swaps its player onto the new PC (after the new stream's first
 * decode, 2–5 s), its reporter still reads the OLD PC — 0 kbps — and the
 * first report after the swap is 0 too; both fall inside the new session's
 * sends and read as a failed rung.
 */
export function deliveryMeterStart(
  now: number,
  afterTierChange: boolean,
  waitAfterChangeMs: number,
): number {
  return afterTierChange ? now + waitAfterChangeMs : now
}

/** Read access to a send history — what the meter needs, and all a fake must provide. */
export interface SendHistoryReader {
  /** Bits sent in `[fromMs, toMs)`, each edge rounded to the NEAREST bucket boundary. */
  bitsBetween(fromMs: number, toMs: number): number
}

/**
 * Bucket width. 100 ms, and edges round to the NEAREST boundary, so a frame is
 * put on the wrong side of a window edge only when it was sent within 50 ms of
 * it — about one frame at 25 fps. Rounding edges inward instead dropped a whole
 * IDR that sat 160 ms inside a window and read a whole rung as 1.5× delivered.
 * 32 s of history is 320 slots.
 */
const SEND_BUCKET_MS = 100

/**
 * Bytes this session sent, bucketed by time. A fixed ring: `record` is on the
 * RTP send path, so it allocates nothing.
 */
export class SendHistory implements SendHistoryReader {
  private readonly bytes: Float64Array
  /** The bucket index each slot currently holds; -1 = empty. */
  private readonly ids: Float64Array

  constructor(spanMs: number) {
    const slots = Math.max(1, Math.ceil(spanMs / SEND_BUCKET_MS))
    this.bytes = new Float64Array(slots)
    this.ids = new Float64Array(slots).fill(-1)
  }

  record(byteCount: number, now: number): void {
    const id = Math.floor(now / SEND_BUCKET_MS)
    const slot = id % this.ids.length
    if (this.ids[slot] !== id) {
      this.ids[slot] = id
      this.bytes[slot] = 0
    }
    this.bytes[slot] = (this.bytes[slot] ?? 0) + byteCount
  }

  bitsBetween(fromMs: number, toMs: number): number {
    const first = Math.round(fromMs / SEND_BUCKET_MS)
    const last = Math.round(toMs / SEND_BUCKET_MS) - 1
    let bytes = 0
    for (let id = first; id <= last; id += 1) {
      const slot = id % this.ids.length
      if (this.ids[slot] === id) bytes += this.bytes[slot] ?? 0
    }
    return bytes * 8
  }
}

interface ClientReport {
  readonly kbps: number
  /** Hub-stamped end of the report's window. */
  readonly endAt: number
}

/**
 * The client's recent reports, and the ratio they imply against a
 * {@link SendHistoryReader}. One meter per adaptive session: `notBefore` is
 * the session's start, because the reports are DEVICE-scoped and a report
 * about time before this session describes the previous one (a re-offer).
 */
export class DeliveryMeter {
  private reports: readonly ClientReport[] = []

  constructor(
    private readonly config: DeliveryMeterConfig,
    private readonly notBefore: number,
  ) {}

  /** Fold one client report. The same report read on several ticks counts once. */
  observe(kbps: number, endAt: number): void {
    if (!Number.isFinite(kbps) || kbps < 0 || !Number.isFinite(endAt)) return
    if (endAt - this.config.clientSampleSpanMs < this.notBefore) return
    if (this.reports.some((r) => r.endAt === endAt)) return
    const horizon = endAt - this.config.historySpanMs
    this.reports = [...this.reports.filter((r) => r.endAt > horizon), { kbps, endAt }].sort(
      (a, b) => a.endAt - b.endAt,
    )
  }

  /**
   * Is the client reporting at all? A fresh report that does not yet cover a
   * whole window is "not measured YET" — different from a client that sends
   * no telemetry, and it must not be climbed on (a 10 %-delivery link would
   * otherwise promote in the seconds before its first window closes).
   */
  isReporting(now: number): boolean {
    const newest = this.reports.at(-1)
    return newest !== undefined && now - newest.endAt <= this.config.maxClientSampleAgeMs
  }

  /**
   * The newest report alone against the same 2 s of sends — the short window
   * a total freeze is judged on. Null when there is none, or it is stale.
   */
  evaluateNewest(history: SendHistoryReader, now: number): DeliveryWindow | null {
    const newest = this.reports.at(-1)
    if (newest === undefined || now - newest.endAt > this.config.maxClientSampleAgeMs) return null
    const span = this.config.clientSampleSpanMs
    return {
      receivedKbps: newest.kbps,
      sentKbps: history.bitsBetween(newest.endAt - span, newest.endAt) / span,
      windowMs: span,
    }
  }

  /**
   * Received vs sent over the newest reports that together cover `windowMs`,
   * or `null` when they do not (yet) — or the newest one is stale.
   */
  evaluate(history: SendHistoryReader, windowMs: number, now: number): DeliveryWindow | null {
    const newest = this.reports.at(-1)
    if (newest === undefined || now - newest.endAt > this.config.maxClientSampleAgeMs) return null
    const span = this.config.clientSampleSpanMs
    let covered = 0
    let receivedBits = 0
    let sentBits = 0
    for (let i = this.reports.length - 1; i >= 0 && covered < windowMs; i -= 1) {
      const r = this.reports[i]
      if (r === undefined || now - (r.endAt - span) > this.config.historySpanMs) break
      covered += span
      receivedBits += r.kbps * span
      sentBits += history.bitsBetween(r.endAt - span, r.endAt)
    }
    if (covered < windowMs) return null
    return { receivedKbps: receivedBits / covered, sentKbps: sentBits / covered, windowMs: covered }
  }
}
