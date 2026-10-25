/**
 * RtmpReader — drives an `RtmpClient`, parses FLV tags from each RTMP
 * VIDEO/AUDIO message, builds AnnexB access units, and surfaces them to
 * the stream-broker via the supplied callbacks.
 *
 * Codec support:
 *   - Video: H.264 (standard FLV) and H.265 (Enhanced FLV / Veovera spec
 *           with FOURCC 'hvc1' or 'hev1'). Param sets are kept as the
 *           AnnexB prefix and prepended to every IDR access unit so
 *           Chrome's HEVC decoder can initialise from a single packet.
 *   - Audio: AAC only. Other codecs are skipped with a warn log.
 *
 * The reader does NOT own the broker's reconnect/backoff loop — it
 * exposes `connect()` / `destroy()` and reports terminal failures via
 * `onError`. The broker re-instantiates a fresh reader on reconnect.
 */

import type { EncodedPacket, IScopedLogger, PushAudioInfo } from '@camstack/types'
import {
  AudioSoundFormat,
  aacSamplingIndexToHz,
  buildH264ParamSetsAnnexB,
  buildH265ParamSetsAnnexB,
  FlvParseError,
  nalusToAnnexB,
  parseFlvAudioTag,
  parseFlvVideoTagWithLengthSize,
  UnsupportedCodecError,
} from './flv-parser.js'
import { RtmpClient, RtmpClientClosedError } from './rtmp-client.js'

export interface RtmpReaderCallbacks {
  /** Called when codec is first identified from the FLV sequence header. */
  onVideoCodec?: (codec: 'h264' | 'h265') => void
  /** Called for every assembled AnnexB access unit. */
  onEncodedPacket: (packet: EncodedPacket) => void
  /** Called once when the AAC sequence header is parsed. */
  onAudioInfo?: (info: PushAudioInfo) => void
  /** Called the first time the connection successfully starts streaming media. */
  onPlaying?: () => void
  /** Called on any terminal failure (TCP close, parse error, unsupported codec). */
  onError: (error: Error) => void
  /** Called once after the read-loop exits (successfully or otherwise). */
  onTeardown?: () => void
}

export class RtmpReader {
  private readonly url: string
  private readonly logger: IScopedLogger | undefined
  private readonly callbacks: RtmpReaderCallbacks
  private client: RtmpClient | null = null
  private destroyed = false

  // Per-stream codec state — captured from the first SequenceHeader we see.
  private videoCodec: 'h264' | 'h265' | null = null
  private h264ParamPrefix: Buffer | null = null
  private h265ParamPrefix: Buffer | null = null
  private naluLengthSize = 4

  private audioInfoEmitted = false
  private firstMediaPacketSeen = false
  private packetCounter = 0

  constructor(url: string, logger: IScopedLogger | undefined, callbacks: RtmpReaderCallbacks) {
    this.url = url
    this.logger = logger
    this.callbacks = callbacks
  }

  async connect(): Promise<void> {
    const client = new RtmpClient(this.url, this.logger?.child('rtmp-client'))
    this.client = client

    try {
      await client.setup()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.logger?.warn('rtmp setup failed', { meta: { error: error.message } })
      this.fail(error)
      return
    }

    void this.runReadLoop(client)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.client?.destroy()
  }

  private async runReadLoop(client: RtmpClient): Promise<void> {
    try {
      for await (const media of client.readLoop()) {
        if (this.destroyed) break

        if (media.codec === 'video') {
          this.handleVideoPacket(media.packet, media.timestamp)
        } else {
          this.handleAudioPacket(media.packet, media.timestamp)
        }

        if (!this.firstMediaPacketSeen) {
          this.firstMediaPacketSeen = true
          this.callbacks.onPlaying?.()
        }
      }
      // readLoop exited cleanly — the only way this happens is destroy()
      this.callbacks.onTeardown?.()
    } catch (err) {
      if (this.destroyed) {
        this.callbacks.onTeardown?.()
        return
      }
      const error = err instanceof Error ? err : new Error(String(err))
      this.fail(error)
    }
  }

  private fail(error: Error): void {
    if (this.destroyed) return
    this.destroyed = true
    this.client?.destroy()
    this.callbacks.onError(error)
  }

  // ── Video path ────────────────────────────────────────────────────────

  private handleVideoPacket(payload: Buffer, timestamp: number): void {
    let tag
    try {
      tag = parseFlvVideoTagWithLengthSize(payload, this.naluLengthSize)
    } catch (err) {
      if (err instanceof UnsupportedCodecError) {
        this.fail(err)
        return
      }
      if (err instanceof FlvParseError) {
        this.logger?.warn('rtmp: skipping malformed video tag', { meta: { error: err.message } })
        return
      }
      throw err
    }

    if (tag.kind === 'video-sequence-header') {
      this.handleVideoSequenceHeader(tag.codec, tag)
      return
    }
    if (tag.kind === 'video-sequence-end') {
      // Treated as an end-of-stream signal — let the read loop exit naturally.
      this.logger?.info('rtmp: video sequence end received')
      return
    }
    // video-coded-frames
    if (!this.videoCodec) {
      // Coded frames before sequence header — skip silently. Some servers
      // start mid-GOP; the next SequenceHeader (or restart) will recover.
      return
    }

    const annexB = this.buildAnnexBAccessUnit(
      tag.codec,
      tag.nalus,
      this.isKeyframeFrameType(tag.frameType),
    )
    if (annexB.length === 0) return

    this.packetCounter++
    const packet: EncodedPacket = {
      type: 'video',
      data: annexB,
      pts: timestamp + tag.compositionTime,
      dts: timestamp,
      keyframe: this.isKeyframeFrameType(tag.frameType),
      codec: tag.codec,
    }
    this.callbacks.onEncodedPacket(packet)
  }

  private handleVideoSequenceHeader(
    codec: 'h264' | 'h265',
    tag: ReturnType<typeof parseFlvVideoTagWithLengthSize>,
  ): void {
    if (tag.kind !== 'video-sequence-header') return

    if (this.videoCodec !== null && this.videoCodec !== codec) {
      this.fail(new Error(`RTMP video codec changed mid-stream: ${this.videoCodec} → ${codec}`))
      return
    }

    if (codec === 'h264' && tag.codec === 'h264') {
      this.videoCodec = 'h264'
      this.naluLengthSize = tag.avcConfig.lengthSizeMinusOne + 1
      this.h264ParamPrefix = buildH264ParamSetsAnnexB(tag.avcConfig)
      this.logger?.info('rtmp: H.264 sequence header', {
        meta: {
          profile: tag.avcConfig.avcProfileIndication,
          level: tag.avcConfig.avcLevelIndication,
          spsCount: tag.avcConfig.sps.length,
          ppsCount: tag.avcConfig.pps.length,
          lengthSize: this.naluLengthSize,
        },
      })
      this.callbacks.onVideoCodec?.('h264')
      return
    }

    if (codec === 'h265' && tag.codec === 'h265') {
      this.videoCodec = 'h265'
      this.naluLengthSize = tag.hevcConfig.lengthSizeMinusOne + 1
      this.h265ParamPrefix = buildH265ParamSetsAnnexB(tag.hevcConfig)
      this.logger?.info('rtmp: H.265 sequence header', {
        meta: {
          profile: tag.hevcConfig.generalProfileIdc,
          level: tag.hevcConfig.generalLevelIdc,
          vpsCount: tag.hevcConfig.vps.length,
          spsCount: tag.hevcConfig.sps.length,
          ppsCount: tag.hevcConfig.pps.length,
          lengthSize: this.naluLengthSize,
        },
      })
      this.callbacks.onVideoCodec?.('h265')
    }
  }

  /**
   * Build the AnnexB access unit. Prepends VPS/SPS/PPS prefix when the
   * frame is a keyframe so downstream consumers (decoder, prebuffer,
   * WebRTC) receive a self-contained access unit on every IDR.
   */
  private buildAnnexBAccessUnit(
    codec: 'h264' | 'h265',
    nalus: ReadonlyArray<Buffer>,
    keyframe: boolean,
  ): Buffer {
    if (nalus.length === 0) return Buffer.alloc(0)
    const body = nalusToAnnexB(nalus)
    if (!keyframe) return body

    const prefix = codec === 'h264' ? this.h264ParamPrefix : this.h265ParamPrefix
    if (!prefix || prefix.length === 0) return body
    return Buffer.concat([prefix, body])
  }

  private isKeyframeFrameType(frameType: number): boolean {
    // FrameType 1 = KEY, 4 = GENERATED_KEYFRAME
    return frameType === 1 || frameType === 4
  }

  // ── Audio path ────────────────────────────────────────────────────────

  private handleAudioPacket(payload: Buffer, timestamp: number): void {
    let tag
    try {
      tag = parseFlvAudioTag(payload)
    } catch (err) {
      if (err instanceof FlvParseError) {
        this.logger?.warn('rtmp: skipping malformed audio tag', { meta: { error: err.message } })
        return
      }
      throw err
    }

    if (tag.kind === 'audio-sequence-header') {
      if (tag.soundFormat !== AudioSoundFormat.AAC) {
        this.logger?.warn('rtmp: non-AAC sequence header — audio skipped', {
          meta: { soundFormat: tag.soundFormat },
        })
        return
      }
      const sampleRate = aacSamplingIndexToHz(tag.audioSpecificConfig.samplingFrequencyIndex)
      const channels =
        tag.audioSpecificConfig.channelConfiguration === 0
          ? 1
          : tag.audioSpecificConfig.channelConfiguration
      if (sampleRate === null) {
        this.logger?.warn('rtmp: AAC reserved sample-rate index — audio skipped', {
          meta: { samplingFrequencyIndex: tag.audioSpecificConfig.samplingFrequencyIndex },
        })
        return
      }
      this.audioInfoEmitted = true
      this.callbacks.onAudioInfo?.({
        codec: 'aac',
        sampleRate,
        channels,
        extraData: new Uint8Array(tag.audioSpecificConfigBytes),
      })
      this.logger?.info('rtmp: AAC sequence header', {
        meta: {
          audioObjectType: tag.audioSpecificConfig.audioObjectType,
          sampleRate,
          channels,
        },
      })
      return
    }

    if (tag.soundFormat !== AudioSoundFormat.AAC) {
      // Non-AAC audio (G.711, ADPCM, …) is not supported on the RTMP path.
      // Drop silently after the first warning to avoid log floods.
      return
    }

    if (!this.audioInfoEmitted) {
      // AAC raw arrived before the sequence header — uncommon but legal.
      // Skip until we see the header (decoder needs ASC to initialise).
      return
    }

    const packet: EncodedPacket = {
      type: 'audio',
      data: tag.data,
      pts: timestamp,
      dts: timestamp,
      keyframe: false,
      codec: 'aac',
    }
    this.callbacks.onEncodedPacket(packet)
  }
}

export { RtmpClientClosedError }
