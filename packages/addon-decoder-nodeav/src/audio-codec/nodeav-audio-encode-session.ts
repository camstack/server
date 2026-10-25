/**
 * NodeAvAudioEncodeSession — encodes one resampled PCM stream into a
 * camera-supported audio codec, in-process via node-av. Feeds the two-way
 * intercom back-channel.
 *
 * Pipeline: raw interleaved PCM → SoftwareResampleContext (source rate/format →
 * encoder rate/format) → AudioFifo → fixed-size encode frames → CodecContext
 * encoder → encoded packets. The AudioFifo bridges the mismatch between the
 * arbitrary sample counts a caller pushes and the FIXED `frameSize` an encoder
 * such as AAC (1024) or Opus (variable) requires.
 *
 * Unlike the ffmpeg subprocess backend, node-av's encoder emits one packet per
 * `receivePacket`, so every `AudioEncodedChunk` corresponds to exactly one
 * encoded frame — `frameComplete: true` is genuinely accurate here.
 *
 * Lifecycle: one runtime per session; every native handle freed in `destroy()`;
 * a `closed` guard makes each method a no-op after teardown. Native access is
 * synchronous so the reusable frames/packet are never re-entered mid-encode.
 */
import type { AudioEncodedChunk, IScopedLogger } from '@camstack/types'
import type { NodeAvRuntime } from './nodeav-runtime-loader.js'
import { resolveAudioCodecAlias, type AudioPcmFormat } from './codec-catalog.js'
import {
  buildChannelLayout,
  resolveAvCodecId,
  type AvSampleFormat,
  type ChannelLayout,
  type NavConstants,
} from './nodeav-av-types.js'

export interface NodeAvAudioEncodeConfig {
  readonly codec: string
  readonly sourceSampleRate: number
  readonly sourceChannels: number
  readonly sourceFormat: AudioPcmFormat
  readonly targetSampleRate: number
  readonly targetChannels: number
  readonly bitrateKbps?: number
}

function sourceSampleFmt(consts: NavConstants, format: AudioPcmFormat): AvSampleFormat {
  return format === 'f32le' ? consts.AV_SAMPLE_FMT_FLT : consts.AV_SAMPLE_FMT_S16
}

function sourceBytesPerSample(format: AudioPcmFormat): number {
  return format === 'f32le' ? 4 : 2
}

type CodecContextInstance = InstanceType<NodeAvRuntime['nav']['CodecContext']>
type SwrInstance = InstanceType<NodeAvRuntime['nav']['SoftwareResampleContext']>
type AudioFifoInstance = InstanceType<NodeAvRuntime['nav']['AudioFifo']>
type PacketInstance = InstanceType<NodeAvRuntime['nav']['Packet']>

export class NodeAvAudioEncodeSession {
  private readonly runtime: NodeAvRuntime
  private readonly cfg: NodeAvAudioEncodeConfig
  private readonly logger: IScopedLogger
  private readonly onChunk: (chunk: AudioEncodedChunk) => void
  private readonly codecName: string

  private readonly ctx: CodecContextInstance
  private readonly swr: SwrInstance
  private readonly fifo: AudioFifoInstance
  private readonly packet: PacketInstance
  private readonly outLayout: ChannelLayout
  private readonly encoderSampleFmt: AvSampleFormat
  private readonly srcSampleFmt: AvSampleFormat
  private readonly srcBytesPerSample: number
  /** Encoder-required samples per frame; `<= 0` means variable (drain all). */
  private readonly frameSize: number

  private ptsSamples = 0
  private closed = false

  constructor(
    runtime: NodeAvRuntime,
    cfg: NodeAvAudioEncodeConfig,
    logger: IScopedLogger,
    onChunk: (chunk: AudioEncodedChunk) => void,
  ) {
    this.runtime = runtime
    this.cfg = cfg
    this.logger = logger
    this.onChunk = onChunk
    this.codecName = resolveAudioCodecAlias(cfg.codec)
    this.srcSampleFmt = sourceSampleFmt(runtime.consts, cfg.sourceFormat)
    this.srcBytesPerSample = sourceBytesPerSample(cfg.sourceFormat)

    const { nav, consts } = runtime
    const codecId = resolveAvCodecId(cfg.codec, consts)
    if (codecId === null) {
      throw new Error(`audio-codec-nodeav: unknown codec '${cfg.codec}' for encode`)
    }
    const codec = nav.Codec.findEncoder(codecId)
    if (!codec) {
      throw new Error(`audio-codec-nodeav: encoder not registered for '${cfg.codec}'`)
    }
    // The encoder's native sample format (e.g. FLTP for AAC). The resampler
    // converts into this; the FIFO + frames carry it; extendedData handles the
    // planar case transparently.
    const fmts = codec.sampleFormats
    this.encoderSampleFmt = fmts && fmts.length > 0 ? fmts[0]! : consts.AV_SAMPLE_FMT_S16
    this.outLayout = buildChannelLayout(consts, cfg.targetChannels)

    const ctx = new nav.CodecContext()
    ctx.allocContext3(codec)
    ctx.sampleRate = cfg.targetSampleRate
    ctx.channelLayout = this.outLayout
    ctx.sampleFormat = this.encoderSampleFmt
    if (cfg.bitrateKbps !== undefined) {
      ctx.bitRate = BigInt(Math.round(cfg.bitrateKbps * 1000))
    }
    const openRet = ctx.open2Sync(codec, null)
    if (openRet < 0) {
      ctx.freeContext()
      throw new Error(
        `audio-codec-nodeav: encoder open2 failed for '${cfg.codec}' (ret=${openRet})`,
      )
    }
    // frameSize is only known after open. 0 → the codec accepts variable frame
    // sizes (opus, pcm, g722): drain the whole FIFO per push.
    this.frameSize = ctx.frameSize > 0 ? ctx.frameSize : 0

    const swr = new nav.SoftwareResampleContext()
    const inLayout = buildChannelLayout(consts, cfg.sourceChannels)
    const allocRet = swr.allocSetOpts2(
      this.outLayout,
      this.encoderSampleFmt,
      cfg.targetSampleRate,
      inLayout,
      this.srcSampleFmt,
      cfg.sourceSampleRate,
    )
    if (allocRet < 0) {
      ctx.freeContext()
      throw new Error(`audio-codec-nodeav: encode swr allocSetOpts2 failed (ret=${allocRet})`)
    }
    if (swr.init() < 0) {
      swr.free()
      ctx.freeContext()
      throw new Error('audio-codec-nodeav: encode swr init failed')
    }

    const fifo = new nav.AudioFifo()
    // Initial capacity is a hint; the FIFO grows on demand. One frame's worth
    // (or 1024 for variable-size codecs) is a sensible seed.
    fifo.alloc(
      this.encoderSampleFmt,
      cfg.targetChannels,
      this.frameSize > 0 ? this.frameSize : 1024,
    )

    const packet = new nav.Packet()
    packet.alloc()

    this.ctx = ctx
    this.swr = swr
    this.fifo = fifo
    this.packet = packet
  }

  /** Push one interleaved PCM chunk; emits encoded packets via `onChunk`. */
  pushPcm(data: Uint8Array): void {
    if (this.closed || data.byteLength === 0) return
    const frameBytes = this.cfg.sourceChannels * this.srcBytesPerSample
    const inSamples = Math.floor(data.byteLength / frameBytes)
    if (inSamples <= 0) return

    this.resampleIntoFifo(data, inSamples)
    this.drainFifo(false)
  }

  /**
   * Flush the encoder: drain any partial frame left in the FIFO, then signal
   * end-of-stream so the codec emits its tail packets. Called before a graceful
   * close.
   */
  flush(): void {
    if (this.closed) return
    this.drainFifo(true)
    // Send a null frame to flush the encoder's internal buffer.
    try {
      const flushRet = this.ctx.sendFrameSync(null)
      if (flushRet >= 0) this.drainEncoder()
    } catch (err) {
      this.logger.warn('audio-codec-nodeav: encode flush failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private resampleIntoFifo(data: Uint8Array, inSamples: number): void {
    const { nav } = this.runtime
    const inFrame = new nav.Frame()
    inFrame.alloc()
    const outFrame = new nav.Frame()
    outFrame.alloc()
    try {
      inFrame.format = this.srcSampleFmt
      inFrame.sampleRate = this.cfg.sourceSampleRate
      inFrame.channelLayout = buildChannelLayout(this.runtime.consts, this.cfg.sourceChannels)
      inFrame.nbSamples = inSamples
      const inBufRet = inFrame.getBuffer(0)
      if (inBufRet < 0) throw new Error(`inFrame.getBuffer failed (ret=${inBufRet})`)
      const planes = inFrame.extendedData
      const plane0 = planes && planes.length > 0 ? planes[0] : null
      if (!plane0) throw new Error('inFrame has no data plane')
      plane0.set(data.subarray(0, inSamples * this.cfg.sourceChannels * this.srcBytesPerSample))

      const outSamples = this.swr.getOutSamples(inSamples)
      if (outSamples <= 0) return
      outFrame.format = this.encoderSampleFmt
      outFrame.sampleRate = this.cfg.targetSampleRate
      outFrame.channelLayout = this.outLayout
      outFrame.nbSamples = outSamples
      const outBufRet = outFrame.getBuffer(0)
      if (outBufRet < 0) throw new Error(`outFrame.getBuffer failed (ret=${outBufRet})`)

      const convRet = this.swr.convertFrame(outFrame, inFrame)
      if (convRet < 0) throw new Error(`swr.convertFrame failed (ret=${convRet})`)
      const produced = outFrame.nbSamples
      if (produced <= 0) return
      const outPlanes = outFrame.extendedData
      if (!outPlanes || outPlanes.length === 0) return
      this.fifo.writeSync(outPlanes, produced)
    } finally {
      inFrame.free()
      outFrame.free()
    }
  }

  /**
   * Pull `frameSize`-sized frames out of the FIFO and encode them. When
   * `flushTail` is set, also encode the final short frame (< frameSize) so no
   * tail samples are dropped on close.
   */
  private drainFifo(flushTail: boolean): void {
    const chunk = this.frameSize > 0 ? this.frameSize : this.fifo.size
    if (chunk <= 0) return
    while (this.fifo.size >= chunk && chunk > 0) {
      this.encodeFromFifo(chunk)
      if (this.frameSize <= 0) break // variable-size: one drain per push
    }
    if (flushTail && this.fifo.size > 0) {
      this.encodeFromFifo(this.fifo.size)
    }
  }

  private encodeFromFifo(nbSamples: number): void {
    if (nbSamples <= 0) return
    const { nav } = this.runtime
    const frame = new nav.Frame()
    frame.alloc()
    try {
      frame.format = this.encoderSampleFmt
      frame.sampleRate = this.cfg.targetSampleRate
      frame.channelLayout = this.outLayout
      frame.nbSamples = nbSamples
      const bufRet = frame.getBuffer(0)
      if (bufRet < 0) throw new Error(`encodeFrame.getBuffer failed (ret=${bufRet})`)
      const planes = frame.extendedData
      if (!planes || planes.length === 0) throw new Error('encodeFrame has no data plane')
      const read = this.fifo.readSync(planes, nbSamples)
      if (read <= 0) return
      frame.nbSamples = read
      frame.pts = BigInt(this.ptsSamples)
      this.ptsSamples += read

      const sendRet = this.ctx.sendFrameSync(frame)
      if (sendRet < 0) throw new Error(`sendFrame failed (ret=${sendRet})`)
      this.drainEncoder()
    } finally {
      frame.free()
    }
  }

  private drainEncoder(): void {
    const { consts } = this.runtime
    for (;;) {
      const recvRet = this.ctx.receivePacketSync(this.packet)
      if (recvRet === consts.AVERROR_EAGAIN || recvRet === consts.AVERROR_EOF) break
      if (recvRet < 0) {
        throw new Error(`audio-codec-nodeav: receivePacket failed (ret=${recvRet})`)
      }
      try {
        const payload = this.packet.data
        if (payload && payload.byteLength > 0) {
          const out = new Uint8Array(new ArrayBuffer(payload.byteLength))
          out.set(payload)
          const pktPts = this.packet.pts
          const ptsMs =
            pktPts >= 0n ? Math.round((Number(pktPts) * 1000) / this.cfg.targetSampleRate) : 0
          this.onChunk({ data: out, codec: this.codecName, pts: ptsMs, frameComplete: true })
        }
      } finally {
        this.packet.unref()
      }
    }
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.freeQuietly(() => this.packet.free(), 'packet')
    this.freeQuietly(() => this.fifo.free(), 'fifo')
    this.freeQuietly(() => this.swr.free(), 'swr')
    this.freeQuietly(() => this.ctx.freeContext(), 'codecContext')
  }

  private freeQuietly(fn: () => void, what: string): void {
    try {
      fn()
    } catch (err) {
      this.logger.warn('audio-codec-nodeav: encode handle free failed', {
        meta: { what, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
