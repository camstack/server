import { IrCodecError } from './ir-error.js'

/**
 * FastLZ level 1: a byte-oriented LZ77 stream. A control byte below 32 starts a
 * literal run of `ctrl + 1` bytes; otherwise it is a back-reference whose length
 * is `ctrl >> 5` (extended by one byte when 7) and whose distance is split
 * between the low 5 bits and the next byte.
 */
const MAX_DISTANCE = 8192
const MAX_LITERAL_RUN = 32
const MIN_MATCH = 3
const MAX_MATCH = 264

export function fastlzDecompress(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let ip = 0
  const next = (): number => {
    const byte = input[ip++]
    if (byte === undefined)
      throw new IrCodecError('tuya-malformed', 'compressed stream is truncated')
    return byte
  }
  while (ip < input.length) {
    const ctrl = next()
    if (ctrl < 32) {
      for (let i = 0; i <= ctrl; i++) out.push(next())
      continue
    }
    let len = (ctrl >> 5) - 1
    if (len === 6) len += next()
    const distance = ((ctrl & 31) << 8) + next() + 1
    const start = out.length - distance
    if (start < 0)
      throw new IrCodecError('tuya-malformed', 'back-reference points before the stream')
    for (let i = 0; i < len + 3; i++) {
      const byte = out[start + i]
      if (byte === undefined) throw new IrCodecError('tuya-malformed', 'back-reference is invalid')
      out.push(byte)
    }
  }
  return Uint8Array.from(out)
}

export function fastlzCompress(input: Uint8Array): Uint8Array {
  const out: number[] = []
  const lastSeen = new Map<number, number>()
  let literalStart = 0
  const flushLiterals = (end: number): void => {
    for (let from = literalStart; from < end; from += MAX_LITERAL_RUN) {
      const to = Math.min(from + MAX_LITERAL_RUN, end)
      out.push(to - from - 1)
      for (let i = from; i < to; i++) out.push(input[i] ?? 0)
    }
  }
  let pos = 0
  while (pos < input.length) {
    let matchLen = 0
    let matchDistance = 0
    if (pos + MIN_MATCH <= input.length) {
      const key = ((input[pos] ?? 0) << 16) | ((input[pos + 1] ?? 0) << 8) | (input[pos + 2] ?? 0)
      const candidate = lastSeen.get(key)
      lastSeen.set(key, pos)
      if (candidate !== undefined && pos - candidate <= MAX_DISTANCE) {
        let len = 0
        while (
          pos + len < input.length &&
          len < MAX_MATCH &&
          input[candidate + len] === input[pos + len]
        )
          len++
        if (len >= MIN_MATCH) {
          matchLen = len
          matchDistance = pos - candidate - 1
        }
      }
    }
    if (matchLen === 0) {
      pos++
      continue
    }
    flushLiterals(pos)
    const enc = matchLen - 2
    if (enc < 7) {
      out.push((enc << 5) | (matchDistance >> 8))
    } else {
      out.push((7 << 5) | (matchDistance >> 8), enc - 7)
    }
    out.push(matchDistance & 255)
    pos += matchLen
    literalStart = pos
  }
  flushLiterals(input.length)
  return Uint8Array.from(out)
}
