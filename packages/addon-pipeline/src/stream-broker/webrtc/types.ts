/**
 * Core types for media stream servers.
 * Protocol-agnostic frame types used across all server implementations.
 */

export type VideoCodec = 'H264' | 'H265'
export type AudioCodec = 'Aac' | 'Adpcm' | 'Opus' | 'Pcmu' | 'Pcma'

/**
 * A single video frame in Annex-B format (with start codes).
 */
export interface VideoFrame {
  /** Raw video data in Annex-B format (NAL units with 0x00000001 start codes) */
  data: Buffer
  /** Video codec type */
  codec: VideoCodec
  /** True if this is a keyframe (IDR for H.264, IRAP for H.265) */
  isKeyframe: boolean
  /** Presentation timestamp in microseconds (monotonic) */
  timestampMicros: number
  /** Optional: frame width in pixels */
  width?: number
  /** Optional: frame height in pixels */
  height?: number
}

/**
 * A single audio frame.
 * For AAC: data should include ADTS headers.
 * For other codecs: raw audio samples.
 */
export interface AudioFrame {
  /** Raw audio data */
  data: Buffer
  /** Audio codec */
  codec: AudioCodec
  /** Sample rate in Hz */
  sampleRate: number
  /** Number of channels */
  channels: number
  /** Presentation timestamp in microseconds */
  timestampMicros: number
}

/**
 * Tagged union for video/audio frames.
 */
export type MediaFrame = { type: 'video'; frame: VideoFrame } | { type: 'audio'; frame: AudioFrame }

/**
 * Primary frame source interface.
 * Yields MediaFrame objects. Returning from the generator signals end of stream.
 * Throwing signals an error that should trigger reconnection.
 */
export type FrameSource = AsyncGenerator<MediaFrame, void, unknown>

/**
 * Factory that creates a new FrameSource.
 * Called each time the server needs to start/restart the stream.
 * The server is responsible for calling return() to stop the source.
 */
export type FrameSourceFactory = () => FrameSource

/**
 * Logger type — delegates to IScopedLogger from @camstack/types.
 * Kept as a type alias for backward compatibility within the package.
 */
import type { IScopedLogger } from '@camstack/types'

export type Logger = IScopedLogger

/**
 * Accept an IScopedLogger or partial implementation and return a compliant IScopedLogger.
 */
export function asLogger(logger?: Partial<IScopedLogger> | Console): IScopedLogger {
  if (!logger) return createNullLogger()
  const noop = (_msg: string, _meta?: Record<string, unknown>) => {}
  // Dynamic dispatch over Partial<IScopedLogger> | Console. Both surfaces expose
  // `info`/`warn`/`error`/`debug` with compatible call signatures but TS does
  // not intersect them; Reflect.get + typeof check is the single boundary.
  type LoggerMethod = IScopedLogger['info']
  const call = (name: 'info' | 'warn' | 'error' | 'debug'): LoggerMethod => {
    const fn: unknown = Reflect.get(logger, name)
    return typeof fn === 'function' ? (fn as LoggerMethod).bind(logger) : noop
  }
  const childFn: unknown = Reflect.get(logger, 'child')
  const withTagsFn: unknown = Reflect.get(logger, 'withTags')
  return {
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
    debug: call('debug'),
    child:
      typeof childFn === 'function'
        ? (childFn as IScopedLogger['child']).bind(logger)
        : (_scope: string) => asLogger(logger),
    withTags:
      typeof withTagsFn === 'function'
        ? (withTagsFn as IScopedLogger['withTags']).bind(logger)
        : (_tags) => asLogger(logger),
  }
}

/**
 * Create a logger that discards all output.
 */
export function createNullLogger(): IScopedLogger {
  const noop = (_msg: string, _meta?: Record<string, unknown>) => {}
  const self: IScopedLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => self,
    withTags: () => self,
  }
  return self
}
