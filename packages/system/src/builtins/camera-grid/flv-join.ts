/**
 * Making one FLV stream joinable by many readers.
 *
 * MPEG-TS is self-describing: a reader attaches mid-stream, waits for the next
 * PAT/PMT and decodes. FLV is not. Its 9-byte signature, its `onMetaData`
 * script tag and its AVC sequence header appear ONCE, at the top, and a reader
 * that arrives later is handed the middle of a tag — ffmpeg answers `Invalid
 * data found when processing input`, which is exactly what the hub did the
 * minute the grid started emitting FLV (2026-09-17). The grid emits FLV because
 * the bundled ffmpeg segfaults remuxing MPEG-TS (D519 notes, same day), so the
 * format is not negotiable and this is the price of it.
 *
 * The join point therefore does two things, and nothing else:
 *
 *  - **remembers what describes the stream** — the header, the newest script
 *    tag, the newest AVC sequence header. Newest, not first: an encoder that
 *    respawns emits a new sequence header, and a reader handed the old one
 *    decodes noise;
 *  - **starts each reader on a tag boundary at a KEYFRAME**, never mid-tag and
 *    never on an inter frame that references pictures the reader never saw.
 *
 * It is a parser, not a buffer: nothing is retained beyond the preamble and the
 * partial tag currently being assembled. A composite at 10 fps with a 2-second
 * GOP makes a reader wait at most two seconds to join, which is the same wait
 * MPEG-TS would have imposed for its next key frame.
 */

/** FLV tag header: type(1) + dataSize(3) + timestamp(3) + extended(1) + streamId(3). */
const TAG_HEADER_BYTES = 11
/** Every tag is followed by its own size as a 4-byte trailer. */
const TAG_TRAILER_BYTES = 4
/** `FLV` + version(1) + flags(1) + dataOffset(4), then PreviousTagSize0(4). */
const FLV_HEADER_BYTES = 13
const TAG_TYPE_SCRIPT = 18
const TAG_TYPE_VIDEO = 9
/** High nibble of a video tag's first byte: 1 = key frame. */
const VIDEO_FRAME_TYPE_KEY = 1
/** Second byte of an AVC video tag: 0 = sequence header, 1 = NALU. */
const AVC_PACKET_TYPE_SEQUENCE_HEADER = 0

interface MutableReader {
  started: boolean
  queued: Buffer[]
}

/**
 * One reader's view of the stream.
 *
 * Every consumer holds one, the first included: a join point with a privileged
 * "primary" reader would have two code paths for the same question, and the
 * grid's first consumer is not special — it just happens to arrive when the
 * preamble is still being learnt.
 */
export class FlvReader {
  constructor(
    private readonly state: MutableReader,
    private readonly detach: (state: MutableReader) => void,
  ) {}

  /** True until the preamble and a key frame have been handed over. */
  get pending(): boolean {
    return !this.state.started
  }

  /** The bytes owed to this reader since the last call, or `null`. */
  take(): Buffer | null {
    const queued = this.state.queued
    if (queued.length === 0) return null
    this.state.queued = []
    return queued.length === 1 ? (queued[0] ?? null) : Buffer.concat(queued)
  }

  /** Stop receiving. Anything queued is dropped with the reader. */
  close(): void {
    this.state.queued = []
    this.detach(this.state)
  }
}

interface ParsedTag {
  readonly bytes: Buffer
  readonly type: number
  readonly isKeyFrame: boolean
  readonly isSequenceHeader: boolean
}

function parseVideoFlags(body: Buffer): { isKeyFrame: boolean; isSequenceHeader: boolean } {
  const first = body[0]
  const second = body[1]
  if (first === undefined) return { isKeyFrame: false, isSequenceHeader: false }
  const frameType = first >> 4
  const sequenceHeader = second === AVC_PACKET_TYPE_SEQUENCE_HEADER
  return {
    // A sequence header is not a picture: it DESCRIBES the stream and belongs
    // to the preamble, never to the "you may start here" decision.
    isKeyFrame: frameType === VIDEO_FRAME_TYPE_KEY && !sequenceHeader,
    isSequenceHeader: sequenceHeader,
  }
}

export class FlvJoinPoint {
  private buffer: Buffer = Buffer.alloc(0)
  private header: Buffer | null = null
  private script: Buffer | null = null
  private sequenceHeader: Buffer | null = null
  private readonly readers = new Set<MutableReader>()

  /** Attach a reader. It receives the preamble at the next key frame. */
  join(): FlvReader {
    const state: MutableReader = { started: false, queued: [] }
    this.readers.add(state)
    return new FlvReader(state, (gone) => this.readers.delete(gone))
  }

  /** Feed bytes from the encoder; each reader then takes what it is owed. */
  accept(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.consumeHeader()
    for (const tag of this.consumeTags()) this.dispatch(tag)
  }

  private consumeHeader(): void {
    if (this.header !== null) return
    if (this.buffer.length < FLV_HEADER_BYTES) return
    this.header = this.buffer.subarray(0, FLV_HEADER_BYTES)
    this.buffer = this.buffer.subarray(FLV_HEADER_BYTES)
  }

  private *consumeTags(): Generator<ParsedTag> {
    if (this.header === null) return
    for (;;) {
      if (this.buffer.length < TAG_HEADER_BYTES) return
      const dataSize = this.buffer.readUIntBE(1, 3)
      const total = TAG_HEADER_BYTES + dataSize + TAG_TRAILER_BYTES
      if (this.buffer.length < total) return
      const bytes = this.buffer.subarray(0, total)
      const type = bytes.readUInt8(0)
      const body = bytes.subarray(TAG_HEADER_BYTES, TAG_HEADER_BYTES + dataSize)
      const flags =
        type === TAG_TYPE_VIDEO
          ? parseVideoFlags(body)
          : { isKeyFrame: false, isSequenceHeader: false }
      this.buffer = this.buffer.subarray(total)
      yield { bytes, type, ...flags }
    }
  }

  private dispatch(tag: ParsedTag): void {
    if (tag.type === TAG_TYPE_SCRIPT) this.script = tag.bytes
    if (tag.isSequenceHeader) this.sequenceHeader = tag.bytes

    for (const reader of this.readers) {
      if (reader.started) {
        reader.queued.push(tag.bytes)
        continue
      }
      if (!tag.isKeyFrame) continue
      const preamble = this.preamble()
      if (preamble === null) continue
      reader.started = true
      reader.queued.push(preamble, tag.bytes)
    }
  }

  /** The bytes that describe the stream, or `null` while any is still unknown. */
  private preamble(): Buffer | null {
    if (this.header === null || this.sequenceHeader === null) return null
    const parts = [this.header]
    // The script tag is optional — ffmpeg writes one, but a stream without it
    // is still decodable, and refusing to start a reader over a missing
    // `onMetaData` would hold it forever.
    if (this.script !== null) parts.push(this.script)
    parts.push(this.sequenceHeader)
    return Buffer.concat(parts)
  }
}
