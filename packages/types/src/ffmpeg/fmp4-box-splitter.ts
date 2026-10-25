/**
 * Fmp4BoxSplitter — cut an ffmpeg fragmented-MP4 byte stream into the units a
 * consumer of fragments actually needs: ONE initialisation segment
 * (`ftyp`+`moov`) followed by one unit per `moof`+`mdat` pair.
 *
 * This is the shape HomeKit Secure Video's `CameraRecordingDelegate` yields
 * (`RecordingPacket` #0 is the initialisation, the rest are media fragments),
 * and it is the same shape a CamStack clip source wants — which is the point.
 * One fragmenter, two consumers (roadmap item 4b, now in the private planning board).
 * The splitter therefore knows about NEITHER of them: it emits units, and
 * {@link import('./fmp4-fragment-plane.js').Fmp4FragmentPlane} decides who gets
 * them.
 *
 * ## Pure, streaming, bounded
 *
 * No I/O, no timers, no ffmpeg. `push` takes whatever bytes arrived and returns
 * whatever units completed — a caller may hand it one byte at a time or a
 * megabyte, and the units are identical either way (asserted). Memory is
 * bounded by {@link Fmp4SplitterOptions.maxUnitBytes}: the splitter holds at
 * most one in-progress unit plus a partial box, and a stream that exceeds the
 * bound FAULTS rather than growing, because the alternative on a live 24/7
 * source is the broker's heap.
 *
 * ## The box rules, from ISO/IEC 14496-12
 *
 * A box header is `size:uint32` + `type:4 chars`. `size == 1` means the real
 * size is a `uint64` in the next 8 bytes; `size == 0` means "to end of file".
 * A size-0 box is a FAULT here and not a special case: it cannot be cut into
 * fragments at all, and pretending otherwise would produce one enormous unit
 * whose bytes never arrive.
 *
 * ## What it does NOT do
 *
 * It never inspects `tfdt`/`trun` and never computes a fragment's duration. The
 * fragment length is decided upstream by the muxer (`-min_frag_duration` plus a
 * key-frame grid, see `@camstack/types` `ffmpeg/invocation.ts`), and a duration
 * parsed here would be a SECOND opinion about the same fact — the failure mode
 * D67 exists to prevent. A consumer that must verify conformance measures the
 * arrival cadence, which is the thing it actually cares about.
 */

/** `init` is the `ftyp`+`moov` head; `fragment` is one `moof`+`mdat` pair. */
export type Fmp4UnitKind = 'init' | 'fragment'

export interface Fmp4Unit {
  readonly kind: Fmp4UnitKind
  /** A standalone copy — the splitter never hands out a view into its buffer. */
  readonly data: Uint8Array
  /** `0` for the initialisation segment, then `1, 2, 3…` per fragment. */
  readonly sequence: number
}

export interface Fmp4SplitterOptions {
  /**
   * The most bytes one unit may reach before the stream is declared unusable.
   * A 4-second 1080p fragment is a few hundred KB; the default leaves three
   * orders of magnitude of headroom and still bounds a source that is not
   * really fMP4 (a plain MP4 with a trailing `moov`, say, whose single `mdat`
   * is the entire recording).
   */
  readonly maxUnitBytes?: number
}

const DEFAULT_MAX_UNIT_BYTES = 16 * 1024 * 1024

/** Header size for a normal box, and for one carrying a 64-bit `largesize`. */
const BOX_HEADER_BYTES = 8
const LARGE_BOX_HEADER_BYTES = 16

type SplitterState =
  /** Accumulating the initialisation segment; ends at the first `moof`. */
  | 'init'
  /** Inside a fragment: a `moof` has opened, its `mdat` has not closed. */
  | 'fragment'
  /** Between fragments. Anything seen here is interstitial. */
  | 'idle'

/** One parsed box header. */
interface BoxHeader {
  readonly type: string
  readonly totalBytes: number
}

export class Fmp4BoxSplitter {
  private readonly maxUnitBytes: number
  /** Bytes of the CURRENT unit plus any partial box after it. */
  private buffer: Uint8Array = new Uint8Array(0)
  /** Where the current unit starts inside {@link buffer}. */
  private unitStart = 0
  /** Where the box scanner has reached inside {@link buffer}. */
  private cursor = 0
  private state: SplitterState = 'init'
  private nextSequence = 0
  private faultReason: string | null = null
  private readonly interstitial = new Set<string>()

  constructor(options: Fmp4SplitterOptions = {}) {
    this.maxUnitBytes = options.maxUnitBytes ?? DEFAULT_MAX_UNIT_BYTES
  }

  /**
   * Non-null once the stream cannot be split. The splitter emits nothing
   * further, so a caller polls this to kill the child rather than watching a
   * silent stall — a fragmenter that quietly stops producing looks exactly like
   * a camera with no motion.
   */
  get fault(): string | null {
    return this.faultReason
  }

  /** Bytes currently held. The memory bound, observable rather than asserted. */
  get pendingBytes(): number {
    return this.buffer.length - this.unitStart
  }

  /**
   * Top-level box types seen BETWEEN fragments and discarded — `mfra`, `free`,
   * a stray `sidx`. Reported rather than dropped in silence: they are legal and
   * useless to a fragment consumer, but a type nobody expected showing up here
   * is the first symptom of a muxer that is not writing what we think it is.
   */
  get discardedInterstitialTypes(): readonly string[] {
    return [...this.interstitial]
  }

  /**
   * Feed bytes; get back whatever units completed. Returns `[]` once faulted.
   */
  push(chunk: Uint8Array): readonly Fmp4Unit[] {
    if (this.faultReason !== null || chunk.length === 0) return []
    this.append(chunk)
    if (this.pendingBytes > this.maxUnitBytes) {
      return this.fail(
        `a single fMP4 unit exceeded ${this.maxUnitBytes} bytes — this stream is not fragmented`,
      )
    }
    return this.drainBoxes()
  }

  // ── internals ──────────────────────────────────────────────────────────

  private append(chunk: Uint8Array): void {
    if (this.buffer.length === 0) {
      this.buffer = chunk.slice()
      return
    }
    const next = new Uint8Array(this.buffer.length + chunk.length)
    next.set(this.buffer, 0)
    next.set(chunk, this.buffer.length)
    this.buffer = next
  }

  /** Consume every COMPLETE top-level box now in the buffer. */
  private drainBoxes(): readonly Fmp4Unit[] {
    const units: Fmp4Unit[] = []
    for (;;) {
      const header = this.readHeader()
      // A unit cut BEFORE the fault is still a valid unit — the caller keeps
      // what it already had and stops on `fault`, rather than losing a good
      // fragment to a later bad header.
      if (this.faultReason !== null) return units
      if (header === null) break
      if (this.cursor + header.totalBytes > this.buffer.length) break

      const boxStart = this.cursor
      const boxEnd = boxStart + header.totalBytes
      this.cursor = boxEnd

      const unit = this.consumeBox(header.type, boxStart, boxEnd)
      if (this.faultReason !== null) return units
      if (unit !== null) units.push(unit)
    }
    this.compact()
    return units
  }

  /**
   * Apply one box to the state machine. Returns a unit when this box CLOSED
   * one, `null` otherwise.
   */
  private consumeBox(type: string, boxStart: number, boxEnd: number): Fmp4Unit | null {
    if (this.state === 'init') {
      if (type !== 'moof') return null
      if (boxStart === this.unitStart) {
        this.fail('a moof arrived before any initialisation box — there is no ftyp/moov to send')
        return null
      }
      // The init segment is everything BEFORE this moof; the moof opens the
      // first fragment, so the cursor stays where it is.
      const init = this.emit('init', this.unitStart, boxStart)
      this.unitStart = boxStart
      this.state = 'fragment'
      return init
    }

    if (this.state === 'idle') {
      if (type !== 'moof') {
        this.interstitial.add(type)
        // Not part of any fragment — drop it by moving the unit start past it.
        this.unitStart = boxEnd
        return null
      }
      this.unitStart = boxStart
      this.state = 'fragment'
      return null
    }

    // state === 'fragment': the pair closes at the first mdat after the moof.
    if (type !== 'mdat') return null
    const fragment = this.emit('fragment', this.unitStart, boxEnd)
    this.unitStart = boxEnd
    this.state = 'idle'
    return fragment
  }

  /**
   * Parse the header at {@link cursor}, or `null` when too few bytes have
   * arrived to know. Faults on a size the splitter cannot honour.
   */
  private readHeader(): BoxHeader | null {
    const available = this.buffer.length - this.cursor
    if (available < BOX_HEADER_BYTES) return null
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
    const size = view.getUint32(this.cursor)
    const type = String.fromCharCode(
      this.buffer[this.cursor + 4] ?? 0,
      this.buffer[this.cursor + 5] ?? 0,
      this.buffer[this.cursor + 6] ?? 0,
      this.buffer[this.cursor + 7] ?? 0,
    )

    if (size === 0) {
      // "To end of file". Legal ISOBMFF and unusable here: the box never
      // closes, so no fragment after it can ever be emitted.
      this.fail(`box "${type}" declares size 0 (to EOF) — an unbounded box cannot be fragmented`)
      return null
    }
    if (size === 1) {
      if (available < LARGE_BOX_HEADER_BYTES) return null
      const large = view.getBigUint64(this.cursor + BOX_HEADER_BYTES)
      if (large > BigInt(this.maxUnitBytes)) {
        this.fail(`box "${type}" declares ${large} bytes, over the ${this.maxUnitBytes} byte bound`)
        return null
      }
      return { type, totalBytes: Number(large) }
    }
    if (size < BOX_HEADER_BYTES) {
      this.fail(`box "${type}" declares an impossible size of ${size} bytes`)
      return null
    }
    return { type, totalBytes: size }
  }

  private emit(kind: Fmp4UnitKind, start: number, end: number): Fmp4Unit {
    const sequence = this.nextSequence
    this.nextSequence += 1
    return { kind, data: this.buffer.slice(start, end), sequence }
  }

  /**
   * Drop everything already emitted or discarded. Without this the buffer is
   * the whole stream and the process dies in hours, not minutes.
   */
  private compact(): void {
    if (this.unitStart === 0) return
    this.buffer = this.buffer.slice(this.unitStart)
    this.cursor -= this.unitStart
    this.unitStart = 0
  }

  private fail(reason: string): readonly Fmp4Unit[] {
    this.faultReason = reason
    this.buffer = new Uint8Array(0)
    this.unitStart = 0
    this.cursor = 0
    return []
  }
}
