/**
 * A minimal, VALID FLV stream for tests.
 *
 * The session no longer forwards arbitrary bytes: it parses the child's FLV and
 * starts each reader on a key frame, so a test that writes `[1,2,3]` at the
 * child is writing something no reader can ever be handed. These builders are
 * the smallest thing that is really an FLV stream.
 */
export const FLV_HEADER = Buffer.from([
  0x46, 0x4c, 0x56, 0x01, 0x01, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00,
])

export function flvTag(type: number, body: Buffer): Buffer {
  const head = Buffer.alloc(11)
  head.writeUInt8(type, 0)
  head.writeUIntBE(body.length, 1, 3)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(body.length + 11)
  return Buffer.concat([head, body, tail])
}

/** `0x17 0x00` — AVC sequence header: describes the stream, is not a picture. */
export const FLV_AVC_CONFIG = flvTag(9, Buffer.from([0x17, 0x00, 0x00, 0x00, 0x00, 0x01, 0x64]))
/** `0x17 0x01` — a key frame, the only place a reader may start. */
export const FLV_KEYFRAME = flvTag(9, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0xaa]))
/** `0x27 0x01` — an inter frame. */
export const FLV_INTER = flvTag(9, Buffer.from([0x27, 0x01, 0x00, 0x00, 0x00, 0xbb]))

/** Header + sequence header + one key frame: enough for any reader to open. */
export const FLV_OPENING = Buffer.concat([FLV_HEADER, FLV_AVC_CONFIG, FLV_KEYFRAME])
