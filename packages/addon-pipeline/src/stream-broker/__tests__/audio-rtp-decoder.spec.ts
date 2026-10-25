import { describe, it, expect, vi } from 'vitest'
import { expandAudioChunkToF32le } from '@camstack/types'
import { AudioRtpDecoder } from '../rtsp/audio-rtp-decoder.js'

/**
 * Build a fake RTP packet: 12-byte header + payload.
 * Header: version=2, PT=0 (PCMU), seq=1, timestamp=0, SSRC=0.
 */
function buildRtpPacket(payload: Buffer): Buffer {
  const header = Buffer.alloc(12)
  header[0] = 0x80 // V=2, P=0, X=0, CC=0
  header[1] = 0 // M=0, PT=0 (PCMU)
  header.writeUInt16BE(1, 2) // sequence
  header.writeUInt32BE(0, 4) // timestamp
  header.writeUInt32BE(0, 8) // SSRC
  return Buffer.concat([header, payload])
}

/** Read a coded chunk the way the plane's consumers do. */
function floatsOf(data: Buffer, format: 'pcmu' | 'pcma'): Float32Array {
  const bytes = expandAudioChunkToF32le(data, format)
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

describe('AudioRtpDecoder', () => {
  describe('PCMU (μ-law)', () => {
    it('emits chunks of ~0.5 s at the SOURCE rate AND the SOURCE format (D450, D455)', () => {
      const chunks: Array<{
        sampleRate: number
        channels: number
        dataLength: number
        format?: string
      }> = []
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => {
        chunks.push({
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
          dataLength: chunk.data.length,
          format: chunk.format,
        })
      })

      // At 8 kHz each G.711 byte is one sample and STAYS one byte: 0.5 s =
      // 4000 samples = 4000 bytes, from exactly 4000 input bytes. The plane
      // carried 16 000 until D455, four times the source, on every one of the
      // four legs it crosses between the broker and the analyzer.
      const payloadSize = 160 // standard G.711 frame (20 ms at 8 kHz)
      const packetsNeeded = 4000 / payloadSize // 25 packets

      for (let i = 0; i < packetsNeeded; i++) {
        const payload = Buffer.alloc(payloadSize, 0xff) // 0xff = μ-law silence
        decoder.processPacket(buildRtpPacket(payload))
      }

      expect(chunks.length).toBe(1)
      expect(chunks[0]!.sampleRate).toBe(8000)
      expect(chunks[0]!.channels).toBe(1)
      expect(chunks[0]!.format).toBe('pcmu')
      expect(chunks[0]!.dataLength).toBe(4000)
    })

    it('carries the payload bytes VERBATIM — nothing is decoded, nothing interpolated', () => {
      const chunks: Buffer[] = []
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => {
        chunks.push(chunk.data)
      })
      // Alternate the two extreme μ-law codes: an upsampler would place a
      // midpoint between every pair, and a decoder would replace the bytes
      // with floats. The chunk is the payload.
      const payload = Buffer.alloc(100)
      for (let j = 0; j < 100; j++) payload[j] = j % 2 === 0 ? 0x80 : 0x00
      decoder.processPacket(buildRtpPacket(payload))
      decoder.flush()

      expect(chunks.length).toBe(1)
      expect(chunks[0]!.length).toBe(100)
      expect([...chunks[0]!]).toEqual([...payload])
    })

    it('expands, at the consumer, to exactly the samples the broker used to send', () => {
      const chunks: Buffer[] = []
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => {
        chunks.push(chunk.data)
      })
      const payload = Buffer.alloc(100)
      for (let j = 0; j < 100; j++) payload[j] = j % 2 === 0 ? 0x80 : 0x00
      decoder.processPacket(buildRtpPacket(payload))
      decoder.flush()

      const floats = floatsOf(chunks[0]!, 'pcmu')
      expect(floats.length).toBe(100)
      for (let j = 0; j < 100; j++) {
        // 0x80 → +8031/32768, 0x00 → −8031/32768 (this table's full scale is
        // ±0.245); an interpolated midpoint would sit at ≈0.
        expect(Math.abs(floats[j]!)).toBeGreaterThan(0.2)
        expect(Math.sign(floats[j]!)).toBe(j % 2 === 0 ? 1 : -1)
      }
    })

    it('produces float samples in [-1.0, 1.0] once expanded', () => {
      let receivedData: Buffer | null = null
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => {
        receivedData = chunk.data
      })

      for (let i = 0; i < 30; i++) {
        const payload = Buffer.alloc(160)
        for (let j = 0; j < 160; j++) {
          payload[j] = (i * 160 + j) % 256
        }
        decoder.processPacket(buildRtpPacket(payload))
      }

      expect(receivedData).not.toBeNull()
      for (const sample of floatsOf(receivedData as unknown as Buffer, 'pcmu')) {
        expect(sample).toBeGreaterThanOrEqual(-1.0)
        expect(sample).toBeLessThanOrEqual(1.0)
      }
    })

    it('should flush remaining samples', () => {
      const chunks: Buffer[] = []
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => {
        chunks.push(chunk.data)
      })

      // Send a small payload that won't fill a full chunk
      const payload = Buffer.alloc(100, 0x80)
      decoder.processPacket(buildRtpPacket(payload))
      expect(chunks.length).toBe(0) // not enough for a full chunk

      decoder.flush()
      expect(chunks.length).toBe(1) // partial chunk emitted
      // 100 input bytes → 100 output bytes (source rate AND source format)
      expect(chunks[0]!.length).toBe(100)
    })

    it('should ignore packets with only RTP header (no payload)', () => {
      const onChunk = vi.fn()
      const decoder = new AudioRtpDecoder('PCMU', onChunk)

      // 12-byte header only
      decoder.processPacket(Buffer.alloc(12))
      decoder.flush()
      expect(onChunk).not.toHaveBeenCalled()
    })

    it('should reset state', () => {
      const chunks: Buffer[] = []
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => {
        chunks.push(chunk.data)
      })

      // Accumulate some data
      const payload = Buffer.alloc(100, 0x80)
      decoder.processPacket(buildRtpPacket(payload))

      // Reset discards buffered data
      decoder.reset()
      decoder.flush()
      expect(chunks.length).toBe(0)
    })

    it('copies out of the accumulator — a reused buffer never rewrites a queued chunk', () => {
      const chunks: Buffer[] = []
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => {
        chunks.push(chunk.data)
      })
      for (let i = 0; i < 25; i++) decoder.processPacket(buildRtpPacket(Buffer.alloc(160, 0xff)))
      const first = Buffer.from(chunks[0]!)
      for (let i = 0; i < 25; i++) decoder.processPacket(buildRtpPacket(Buffer.alloc(160, 0x80)))

      expect(chunks.length).toBe(2)
      expect([...chunks[0]!]).toEqual([...first])
    })
  })

  describe('PCMA (A-law)', () => {
    it('labels its chunks pcma — the two codecs are never interchangeable', () => {
      const chunks: Array<{ sampleRate: number; channels: number; format?: string }> = []
      const decoder = new AudioRtpDecoder('PCMA', (chunk) => {
        chunks.push({
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
          format: chunk.format,
        })
      })

      for (let i = 0; i < 30; i++) {
        const payload = Buffer.alloc(160, 0xd5) // A-law silence
        decoder.processPacket(buildRtpPacket(payload))
      }

      expect(chunks.length).toBeGreaterThanOrEqual(1)
      expect(chunks[0]!.sampleRate).toBe(8000)
      expect(chunks[0]!.channels).toBe(1)
      expect(chunks[0]!.format).toBe('pcma')
    })

    it('produces float samples in [-1.0, 1.0] range for A-law once expanded', () => {
      let receivedData: Buffer | null = null
      const decoder = new AudioRtpDecoder('PCMA', (chunk) => {
        receivedData = chunk.data
      })

      for (let i = 0; i < 30; i++) {
        const payload = Buffer.alloc(160)
        for (let j = 0; j < 160; j++) {
          payload[j] = (i * 7 + j * 13) % 256
        }
        decoder.processPacket(buildRtpPacket(payload))
      }

      expect(receivedData).not.toBeNull()
      for (const sample of floatsOf(receivedData as unknown as Buffer, 'pcma')) {
        expect(sample).toBeGreaterThanOrEqual(-1.0)
        expect(sample).toBeLessThanOrEqual(1.0)
      }
    })
  })

  describe('μ-law decode correctness', () => {
    // These guard the TABLE, which moved to `@camstack/types` when the decoder
    // stopped decoding (D455). They are asserted through the chunk the decoder
    // emits so the path stays end to end: a decoder that mislabelled its codec
    // would fail here even with a correct table.
    it('decodes μ-law 0xff (near silence) to ~0', () => {
      const chunks: Buffer[] = []
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => chunks.push(chunk.data))
      for (let i = 0; i < 30; i++) {
        decoder.processPacket(buildRtpPacket(Buffer.alloc(160, 0xff)))
      }
      expect(chunks.length).toBeGreaterThan(0)
      expect(Math.abs(floatsOf(chunks[0]!, 'pcmu')[0]!)).toBeLessThan(0.01)
    })

    it('decodes μ-law 0x80 (max positive magnitude) to a large value', () => {
      const chunks: Buffer[] = []
      const decoder = new AudioRtpDecoder('PCMU', (chunk) => chunks.push(chunk.data))
      for (let i = 0; i < 30; i++) {
        decoder.processPacket(buildRtpPacket(Buffer.alloc(160, 0x80)))
      }
      expect(chunks.length).toBeGreaterThan(0)
      expect(Math.abs(floatsOf(chunks[0]!, 'pcmu')[0]!)).toBeGreaterThan(0.2)
    })
  })
})
