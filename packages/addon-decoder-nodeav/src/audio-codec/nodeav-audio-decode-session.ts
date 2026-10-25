/**
 * NodeAvAudioDecodeSession — decodes one encoded audio stream into resampled
 * interleaved PCM, entirely in-process via node-av's low-level libavcodec +
 * libswresample bindings. No subprocess, no ADTS/Ogg container wrapping: raw
 * depacketized access units are fed straight into `CodecContext.sendPacket`,
 * which is exactly why the ffmpeg addon's `adts.ts` / `ogg-opus-framer.ts`
 * container shims are unnecessary on this backend.
 *
 * Lifecycle: one runtime per session, owned by the addon. Holds a CodecContext,
 * a SoftwareResampleContext, and a reusable Packet + input/output Frame. Every
 * native handle is released in `destroy()`; a `closed` guard makes every method
 * a no-op after teardown so a late `pushEncoded` from an in-flight cap call can
 * never touch a freed context.
 *
 * Native access is synchronous (`sendPacketSync` / `receiveFrameSync`) so the
 * shared reusable Packet/Frame are never re-entered by an interleaved async
 * call — the whole decode of one input packet completes before the method
 * returns.
 */
import type { AudioPcmChunk, IScopedLogger, PcmSampleFormat } from '@camstack/types'
import type { NodeAvRuntime } from './nodeav-runtime-loader.js'
import { type AudioPcmFormat } from './codec-catalog.js'
import {
  buildChannelLayout,
  resolveAvCodecId,
  type AvSampleFormat,
  type ChannelLayout,
  type NavConstants,
} from './nodeav-av-types.js'

export interface NodeAvAudioDecodeConfig {
  readonly codec: string
  readonly sourceSampleRate: number
  readonly sourceChannels: number
  readonly extraData?: Uint8Array
  readonly targetSampleRate: number
  readonly targetChannels: number
  readonly targetFormat: AudioPcmFormat
}

function targetSampleFmt(consts: NavConstants, format: AudioPcmFormat): AvSampleFormat {
  return format === 'f32le' ? consts.AV_SAMPLE_FMT_FLT : consts.AV_SAMPLE_FMT_S16
}

function bytesPerSample(format: AudioPcmFormat): number {
  return format === 'f32le' ? 4 : 2
}

// node-av low-level instances are structurally typed off the module surface —
// the classes' constructors are public here (unlike the high-level factories),
// so `InstanceType` names them without dragging a value import.
type CodecContextInstance = InstanceType<NodeAvRuntime['nav']['CodecContext']>
type SwrInstance = InstanceType<NodeAvRuntime['nav']['SoftwareResampleContext']>
type PacketInstance = InstanceType<NodeAvRuntime['nav']['Packet']>
type FrameInstance = InstanceType<NodeAvRuntime['nav']['Frame']>

export class NodeAvAudioDecodeSession {
  private readonly runtime: NodeAvRuntime
  private readonly cfg: NodeAvAudioDecodeConfig
  private readonly logger: IScopedLogger
  private readonly onPcm: (chunk: AudioPcmChunk) => void

  private readonly ctx: CodecContextInstance
  private readonly swr: SwrInstance
  private readonly packet: PacketInstance
  private readonly inFrame: FrameInstance
  private readonly outFrame: FrameInstance
  private readonly outLayout: ChannelLayout
  private readonly outSampleFmt: AvSampleFormat
  private readonly outBytesPerSample: number
  private readonly outFormat: PcmSampleFormat

  private nextPts = 0
  private closed = false

  /**
   * Synchronously build a decode runtime from the already-loaded node-av
   * runtime. Throws (freeing anything already allocated) on any libav error so
   * the addon surfaces a clean "decode session failed" without leaking a
   * half-open context.
   */
  constructor(
    runtime: NodeAvRuntime,
    cfg: NodeAvAudioDecodeConfig,
    logger: IScopedLogger,
    onPcm: (chunk: AudioPcmChunk) => void,
  ) {
    this.runtime = runtime
    this.cfg = cfg
    this.logger = logger
    this.onPcm = onPcm
    this.outFormat = cfg.targetFormat
    this.outBytesPerSample = bytesPerSample(cfg.targetFormat)

    const { nav, consts } = runtime
    const codecId = resolveAvCodecId(cfg.codec, consts)
    if (codecId === null) {
      throw new Error(`audio-codec-nodeav: unknown codec '${cfg.codec}' for decode`)
    }
    const codec = nav.Codec.findDecoder(codecId)
    if (!codec) {
      throw new Error(`audio-codec-nodeav: decoder not registered for '${cfg.codec}'`)
    }

    const ctx = new nav.CodecContext()
    ctx.allocContext3(codec)
    ctx.sampleRate = cfg.sourceSampleRate
    const inLayout = buildChannelLayout(consts, cfg.sourceChannels)
    ctx.channelLayout = inLayout
    if (cfg.extraData && cfg.extraData.byteLength > 0) {
      ctx.extraData = Buffer.from(cfg.extraData)
    }
    const openRet = ctx.open2Sync(codec, null)
    if (openRet < 0) {
      ctx.freeContext()
      throw new Error(`audio-codec-nodeav: open2 failed for '${cfg.codec}' (ret=${openRet})`)
    }

    const inSampleFmt = ctx.sampleFormat
    this.outSampleFmt = targetSampleFmt(consts, cfg.targetFormat)
    this.outLayout = buildChannelLayout(consts, cfg.targetChannels)

    const swr = new nav.SoftwareResampleContext()
    const allocRet = swr.allocSetOpts2(
      this.outLayout,
      this.outSampleFmt,
      cfg.targetSampleRate,
      inLayout,
      inSampleFmt,
      cfg.sourceSampleRate,
    )
    if (allocRet < 0) {
      ctx.freeContext()
      throw new Error(`audio-codec-nodeav: swr allocSetOpts2 failed (ret=${allocRet})`)
    }
    const initRet = swr.init()
    if (initRet < 0) {
      swr.free()
      ctx.freeContext()
      throw new Error(`audio-codec-nodeav: swr init failed (ret=${initRet})`)
    }

    const packet = new nav.Packet()
    packet.alloc()
    const inFrame = new nav.Frame()
    inFrame.alloc()
    const outFrame = new nav.Frame()
    outFrame.alloc()

    this.ctx = ctx
    this.swr = swr
    this.packet = packet
    this.inFrame = inFrame
    this.outFrame = outFrame
  }

  /** Decode one encoded access unit, emitting resampled PCM via `onPcm`. */
  pushEncoded(data: Uint8Array, pts?: number): void {
    if (this.closed) return
    const { consts } = this.runtime
    this.packet.data = Buffer.from(data)
    if (pts !== undefined) {
      const p = BigInt(Math.round(pts))
      this.packet.pts = p
      this.packet.dts = p
    }
    const sendRet = this.ctx.sendPacketSync(this.packet)
    if (sendRet < 0 && sendRet !== consts.AVERROR_EAGAIN) {
      throw new Error(`audio-codec-nodeav: sendPacket failed (ret=${sendRet})`)
    }

    for (;;) {
      const recvRet = this.ctx.receiveFrameSync(this.inFrame)
      if (recvRet === consts.AVERROR_EAGAIN || recvRet === consts.AVERROR_EOF) break
      if (recvRet < 0) {
        throw new Error(`audio-codec-nodeav: receiveFrame failed (ret=${recvRet})`)
      }
      try {
        const chunk = this.resampleFrame(this.inFrame)
        if (chunk) this.onPcm(chunk)
      } finally {
        this.inFrame.unref()
      }
    }
  }

  private resampleFrame(inFrame: FrameInstance): AudioPcmChunk | null {
    // Exact worst-case output size for this input frame's sample count, plus
    // any samples the resampler has buffered internally (v6 binds
    // getOutSamples — no ceil+slack estimate needed).
    const outSamples = this.swr.getOutSamples(inFrame.nbSamples)
    if (outSamples <= 0) return null

    this.outFrame.unref()
    this.outFrame.format = this.outSampleFmt
    this.outFrame.sampleRate = this.cfg.targetSampleRate
    this.outFrame.channelLayout = this.outLayout
    this.outFrame.nbSamples = outSamples
    const bufRet = this.outFrame.getBuffer(0)
    if (bufRet < 0) {
      throw new Error(`audio-codec-nodeav: outFrame.getBuffer failed (ret=${bufRet})`)
    }

    const convRet = this.swr.convertFrame(this.outFrame, inFrame)
    if (convRet < 0) {
      throw new Error(`audio-codec-nodeav: swr.convertFrame failed (ret=${convRet})`)
    }

    const produced = this.outFrame.nbSamples
    if (produced <= 0) return null

    // Target formats (S16 / FLT) are interleaved (non-planar): the entire
    // payload sits in plane 0.
    const planes = this.outFrame.extendedData
    const plane0 = planes && planes.length > 0 ? planes[0] : null
    if (!plane0) return null
    const bytes = produced * this.cfg.targetChannels * this.outBytesPerSample
    const out = new Uint8Array(new ArrayBuffer(bytes))
    out.set(plane0.subarray(0, bytes))

    const ptsMs = this.nextPts
    this.nextPts = ptsMs + Math.round((produced * 1000) / this.cfg.targetSampleRate)
    return {
      data: out,
      sampleRate: this.cfg.targetSampleRate,
      channels: this.cfg.targetChannels,
      format: this.outFormat,
      pts: ptsMs,
    }
  }

  /** Release every native handle. Idempotent; safe to call from a reaper. */
  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.freeQuietly(() => this.outFrame.free(), 'outFrame')
    this.freeQuietly(() => this.inFrame.free(), 'inFrame')
    this.freeQuietly(() => this.packet.free(), 'packet')
    this.freeQuietly(() => this.swr.free(), 'swr')
    this.freeQuietly(() => this.ctx.freeContext(), 'codecContext')
  }

  private freeQuietly(fn: () => void, what: string): void {
    try {
      fn()
    } catch (err) {
      this.logger.warn('audio-codec-nodeav: decode handle free failed', {
        meta: { what, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
