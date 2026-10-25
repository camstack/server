/**
 * Camera Analysis Pipeline -- unified stream processing.
 */

export interface NormalizedSource {
  type: 'url' | 'pipe'
  url?: string
  pipe?: NodeJS.ReadableStream
  capabilities: SourceCapabilities
}

export interface SourceCapabilities {
  hasVideo: boolean
  hasAudio: boolean
  videoCodec?: 'h264' | 'h265' | 'mjpeg' | 'vp8' | 'vp9' | 'av1'
  audioCodec?: 'aac' | 'opus' | 'pcm' | 'g711'
  width?: number
  height?: number
  fps?: number
  sampleRate?: number
  audioChannels?: number
}

// --- Video Frame Bus ---

export interface VideoFrame {
  data: Buffer
  format: 'jpeg' | 'raw-yuv420' | 'raw-rgb' | 'h264-nal'
  width: number
  height: number
  pts: number
  timestamp: number
  keyframe?: boolean
}

export interface AudioChunk {
  data: Buffer
  format: 'pcm-s16le' | 'pcm-f32le' | 'aac' | 'opus'
  sampleRate: number
  channels: number
  pts: number
  timestamp: number
  dBFS?: number
}

// --- Camera Pipeline ---

export interface ICameraPipeline {
  readonly deviceId: number
  readonly active: boolean

  start(): Promise<void>
  stop(): Promise<void>

  onVideoFrame(callback: VideoFrameCallback, options?: FrameSubscriptionOptions): () => void
  getLatestFrame(): VideoFrame | null

  onAudioChunk(callback: AudioChunkCallback): () => void
  getAudioLevel(): number

  getOutputStream(format: PipelineOutputFormat): PipelineOutputStream | null
  getAvailableOutputs(): PipelineOutputFormat[]

  getStatus(): PipelineStatusInfo
}

export type VideoFrameCallback = (frame: VideoFrame) => void
export type AudioChunkCallback = (chunk: AudioChunk) => void

export interface FrameSubscriptionOptions {
  maxFps?: number
  format?: 'jpeg' | 'raw-yuv420' | 'raw-rgb'
  maxWidth?: number
  maxHeight?: number
  keyframeOnly?: boolean
}

// --- Pipeline Output Streams ---

export type PipelineOutputFormat = 'webrtc' | 'hls' | 'mjpeg' | 'rtsp' | 'raw-h264'

export interface PipelineOutputStream {
  format: PipelineOutputFormat
  url?: string
  createOffer?(): Promise<string>
  handleAnswer?(sdp: string): Promise<void>
  pipe?: NodeJS.ReadableStream
  consumerCount: number
}

export interface PipelineStatusInfo {
  active: boolean
  source: {
    protocol: string
    connected: boolean
    capabilities: SourceCapabilities
  } | null
  decode: {
    fps: number
    droppedFrames: number
    totalFrames: number
  }
  videoConsumers: number
  audioConsumers: number
  outputs: Array<{
    format: PipelineOutputFormat
    consumers: number
    active: boolean
  }>
  uptime: number
}

// --- Pipeline Manager ---

export interface IPipelineManager {
  getPipeline(deviceId: number): ICameraPipeline | null
  createPipeline(deviceId: number, source: NormalizedSource): ICameraPipeline
  destroyPipeline(deviceId: number): Promise<void>
  listPipelines(): Array<{ deviceId: number; status: PipelineStatusInfo }>
}

// --- Addon capability for pipeline consumers ---

export interface IPipelineConsumer {
  id: string
  name: string
  videoRequirements?: FrameSubscriptionOptions
  needsAudio: boolean
  attachToPipeline(pipeline: ICameraPipeline, deviceId: number): void
  detachFromPipeline(deviceId: number): void
}
