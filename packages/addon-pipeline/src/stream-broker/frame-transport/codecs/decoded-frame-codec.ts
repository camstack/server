/**
 * Codec specialized for `DecodedFrame` values.
 *
 * Wraps a fixed-size binary header + raw payload inside a
 * `LengthPrefixCodec` so the transport layer doesn't need to know the
 * shape. Using a bespoke binary layout (instead of JSON via superjson)
 * keeps per-frame overhead low — critical on the hot path where a broker
 * fans out a frame to many consumers at 30+ fps.
 *
 * Wire format (after the length prefix added by LengthPrefixCodec):
 *
 *   Offset  Size  Field
 *   ──────  ────  ─────────────────────────────────────────────────
 *   0       8     timestamp (BE bigint64, ms epoch)
 *   8       4     width  (BE uint32)
 *   12      4     height (BE uint32)
 *   16      1     format enum (0=jpeg, 1=rgb, 2=yuv420, 3=gray, 4=bgr)
 *   17      3     reserved (zero-padded for 4-byte alignment)
 *   20      N     frame data
 *
 * Fixed header: 20 bytes. All subsequent bytes are the raw frame payload.
 * The outer `LengthPrefixCodec` adds the 4-byte length prefix, so the
 * total on-wire size per frame is `4 + 20 + data.length` = 24 + data.
 *
 * Enum values are append-only: existing values must never be reassigned
 * — a worker built before a new format is added would still send the
 * old code over the wire.
 */
import type { DecodedFrame } from '@camstack/types'
import { LengthPrefixCodec } from './length-prefix-codec.js'

const HEADER_BYTES = 20
const FORMAT_MAP = {
  jpeg: 0,
  rgb: 1,
  yuv420: 2,
  gray: 3,
  bgr: 4,
} as const satisfies Record<DecodedFrame['format'], number>

type FormatNumber = (typeof FORMAT_MAP)[keyof typeof FORMAT_MAP]

const FORMAT_REVERSE: Readonly<Record<FormatNumber, DecodedFrame['format']>> = {
  0: 'jpeg',
  1: 'rgb',
  2: 'yuv420',
  3: 'gray',
  4: 'bgr',
}

function isKnownFormatNumber(n: number): n is FormatNumber {
  return n === 0 || n === 1 || n === 2 || n === 3 || n === 4
}

export function encodeDecodedFrame(frame: DecodedFrame): Uint8Array {
  const payload = Buffer.allocUnsafe(HEADER_BYTES + frame.data.length)
  payload.writeBigInt64BE(BigInt(frame.timestamp), 0)
  payload.writeUInt32BE(frame.width, 8)
  payload.writeUInt32BE(frame.height, 12)
  payload.writeUInt8(FORMAT_MAP[frame.format], 16)
  // Zero-fill the 3 reserved bytes (17..19)
  payload.writeUInt8(0, 17)
  payload.writeUInt8(0, 18)
  payload.writeUInt8(0, 19)
  payload.set(frame.data, HEADER_BYTES)
  return payload
}

export function decodeDecodedFrame(bytes: Uint8Array): DecodedFrame {
  if (bytes.length < HEADER_BYTES) {
    throw new Error(`decodeDecodedFrame: payload too short (${bytes.length} < ${HEADER_BYTES})`)
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const timestampBig = buf.readBigInt64BE(0)
  // Safe because timestamps in ms fit in Number.MAX_SAFE_INTEGER until year 287396.
  const timestamp = Number(timestampBig)
  const width = buf.readUInt32BE(8)
  const height = buf.readUInt32BE(12)
  const formatNum = buf.readUInt8(16)
  if (!isKnownFormatNumber(formatNum)) {
    throw new Error(`decodeDecodedFrame: unknown format enum ${formatNum}`)
  }
  const format = FORMAT_REVERSE[formatNum]
  const data = Buffer.from(buf.subarray(HEADER_BYTES))
  return { data, width, height, format, timestamp }
}

/**
 * Pre-built codec instance for `DecodedFrame`.
 * Composes `LengthPrefixCodec` with the DecodedFrame serializers above.
 */
export const decodedFrameCodec = new LengthPrefixCodec<DecodedFrame>({
  kind: 'decoded-frame',
  serialize: encodeDecodedFrame,
  deserialize: decodeDecodedFrame,
})
