import { randomUUID } from 'node:crypto'
import type {
  IAudioCodecCapProvider,
  IScopedLogger,
  AudioCodecInfo,
  AudioDecodeSessionConfig,
  AudioEncodeSessionConfig,
  AudioPcmChunk,
  AudioEncodedChunk,
  PcmSampleFormat,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import {
  CODEC_CATALOG,
  catalogEntryFor,
  codecSupports,
  resolveAudioCodecAlias,
  type AudioPcmFormat,
} from './codec-catalog.js'
import type { NodeAvRuntime } from './nodeav-runtime-loader.js'
import { NodeAvAudioDecodeSession } from './nodeav-audio-decode-session.js'
import { NodeAvAudioEncodeSession } from './nodeav-audio-encode-session.js'

// ── Session state ────────────────────────────────────────────────────────────

interface DecodeSessionState {
  readonly sessionId: string
  readonly kind: 'decode'
  readonly config: AudioDecodeSessionConfig
  readonly tag?: string
  readonly createdAtMs: number
  lastActivityMs: number
  framesIn: number
  framesOut: number
  readonly pcmQueue: AudioPcmChunk[]
  session: NodeAvAudioDecodeSession | null
}

interface EncodeSessionState {
  readonly sessionId: string
  readonly kind: 'encode'
  readonly config: AudioEncodeSessionConfig
  readonly tag?: string
  readonly createdAtMs: number
  lastActivityMs: number
  framesIn: number
  framesOut: number
  readonly encodedQueue: AudioEncodedChunk[]
  session: NodeAvAudioEncodeSession | null
}

type SessionState = DecodeSessionState | EncodeSessionState

const DEFAULT_IDLE_MS = 30_000
// Same drop-oldest bound as the ffmpeg addon: a healthy consumer drains via
// pullPcm every 40ms, so this is never hit in normal operation; it caps the
// external-memory blast radius if a session ever goes un-pulled.
const MAX_PCM_QUEUE_CHUNKS = 500
// Same drop-oldest bound for the encode path: a healthy consumer drains via
// pullEncoded, so this is never hit in normal operation; it caps the
// external-memory blast radius if an encode session is created but never pulled
// (e.g. a consumer that crashes between createEncodeSession and pullEncoded).
const MAX_ENCODED_QUEUE_CHUNKS = 500
const REAPER_INTERVAL_MS = 5_000
/** Grace wait for the encoder to drain its tail after `flushEncode`. */
const FLUSH_DRAIN_MS = 60

/**
 * Audio codec I/O box backed by **node-av's in-process libavcodec +
 * libswresample bindings** — the native counterpart to `audio-codec-ffmpeg`.
 * Decode/encode run in this addon's process (no subprocess), feeding raw
 * depacketized access units straight into a `CodecContext` (no ADTS/Ogg
 * container shim needed).
 *
 * This is a PLAIN provider (not a `BaseAddon`): it is owned and driven by the
 * `decoder-nodeav` addon, which loads the shared node-av runtime once and
 * hands it in. When node-av cannot be loaded on this node the owning addon
 * never constructs this provider, so the singleton slot falls back to
 * `audio-codec-ffmpeg`.
 */
export class NodeAvAudioCodecProvider implements IAudioCodecCapProvider {
  private readonly sessions = new Map<string, SessionState>()
  private reaperTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly deps: {
      logger: IScopedLogger
      runtime: NodeAvRuntime
      resolveLocalNodeId: () => string
    },
  ) {}

  /** Arm the idle-session reaper. Called by the owning addon after construction. */
  start(): void {
    this.reaperTimer = setInterval(() => this.reapIdleSessions(), REAPER_INTERVAL_MS)
    if (typeof this.reaperTimer.unref === 'function') this.reaperTimer.unref()
  }

  /** Stop the reaper and dispose every live session. Called on addon shutdown. */
  stop(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = null
    }
    for (const s of this.sessions.values()) {
      this.disposeSession(s)
    }
    this.sessions.clear()
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  async listSupportedCodecs(): Promise<AudioCodecInfo[]> {
    return CODEC_CATALOG.map((e) => ({
      codec: e.codec,
      canDecode: e.canDecode,
      canEncode: e.canEncode,
      ...(e.label ? { label: e.label } : {}),
    }))
  }

  async canHandle(input: { codec: string; kind: 'decode' | 'encode' }): Promise<boolean> {
    return codecSupports(input.codec, input.kind)
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  async createDecodeSession(
    input: AudioDecodeSessionConfig,
  ): Promise<{ sessionId: string; nodeId: string }> {
    const codec = resolveAudioCodecAlias(input.codec)
    const entry = catalogEntryFor(input.codec)
    if (!entry || !entry.canDecode) {
      throw new Error(`audio-codec-nodeav: decode unsupported for codec '${input.codec}'`)
    }
    const sessionId = `dec-${randomUUID()}`
    const state: DecodeSessionState = {
      sessionId,
      kind: 'decode',
      config: { ...input, codec },
      ...(input.tag ? { tag: input.tag } : {}),
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
      framesIn: 0,
      framesOut: 0,
      pcmQueue: [],
      session: null,
    }
    state.session = this.spawnDecodeSession(state)
    this.sessions.set(sessionId, state)
    this.deps.logger.info('audio-codec-nodeav: decode session created', {
      tags: { sessionId },
      meta: { codec, target: `${input.targetSampleRate}Hz×${input.targetChannels}` },
    })
    return { sessionId, nodeId: this.deps.resolveLocalNodeId() }
  }

  async createEncodeSession(
    input: AudioEncodeSessionConfig,
  ): Promise<{ sessionId: string; nodeId: string }> {
    const codec = resolveAudioCodecAlias(input.codec)
    const entry = catalogEntryFor(input.codec)
    if (!entry || !entry.canEncode) {
      throw new Error(`audio-codec-nodeav: encode unsupported for codec '${input.codec}'`)
    }
    const sessionId = `enc-${randomUUID()}`
    const state: EncodeSessionState = {
      sessionId,
      kind: 'encode',
      config: { ...input, codec },
      ...(input.tag ? { tag: input.tag } : {}),
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
      framesIn: 0,
      framesOut: 0,
      encodedQueue: [],
      session: null,
    }
    state.session = this.spawnEncodeSession(state)
    this.sessions.set(sessionId, state)
    this.deps.logger.info('audio-codec-nodeav: encode session created', {
      tags: { sessionId },
      meta: { codec, target: `${input.targetSampleRate}Hz×${input.targetChannels}` },
    })
    return { sessionId, nodeId: this.deps.resolveLocalNodeId() }
  }

  async closeSession(input: { sessionId: string }): Promise<void> {
    const s = this.sessions.get(input.sessionId)
    if (!s) return
    this.disposeSession(s)
    this.sessions.delete(input.sessionId)
  }

  // ── Decode data plane ────────────────────────────────────────────────────

  async pushEncodedFrame(input: {
    sessionId: string
    data: Uint8Array
    pts?: number
  }): Promise<void> {
    const s = this.sessions.get(input.sessionId)
    if (!s || s.kind !== 'decode') {
      throw new Error(`audio-codec-nodeav: decode session '${input.sessionId}' not found`)
    }
    s.lastActivityMs = Date.now()
    s.framesIn++
    if (!s.session) s.session = this.spawnDecodeSession(s)
    s.session.pushEncoded(input.data, input.pts)
  }

  async pullPcm(input: { sessionId: string; maxCount: number }): Promise<AudioPcmChunk[]> {
    const s = this.sessions.get(input.sessionId)
    if (!s || s.kind !== 'decode') {
      throw new Error(`audio-codec-nodeav: decode session '${input.sessionId}' not found`)
    }
    s.lastActivityMs = Date.now()
    const out = s.pcmQueue.splice(0, input.maxCount)
    s.framesOut += out.length
    return out
  }

  // ── Encode data plane ────────────────────────────────────────────────────

  async pushPcm(input: { sessionId: string; data: Uint8Array; pts?: number }): Promise<void> {
    const s = this.sessions.get(input.sessionId)
    if (!s || s.kind !== 'encode') {
      throw new Error(`audio-codec-nodeav: encode session '${input.sessionId}' not found`)
    }
    s.lastActivityMs = Date.now()
    s.framesIn++
    if (!s.session) s.session = this.spawnEncodeSession(s)
    s.session.pushPcm(input.data)
  }

  async pullEncoded(input: { sessionId: string; maxCount: number }): Promise<AudioEncodedChunk[]> {
    const s = this.sessions.get(input.sessionId)
    if (!s || s.kind !== 'encode') {
      throw new Error(`audio-codec-nodeav: encode session '${input.sessionId}' not found`)
    }
    s.lastActivityMs = Date.now()
    const out = s.encodedQueue.splice(0, input.maxCount)
    s.framesOut += out.length
    return out
  }

  async flushEncode(input: { sessionId: string }): Promise<AudioEncodedChunk[]> {
    const s = this.sessions.get(input.sessionId)
    if (!s || s.kind !== 'encode') {
      throw new Error(`audio-codec-nodeav: encode session '${input.sessionId}' not found`)
    }
    s.lastActivityMs = Date.now()
    s.session?.flush()
    await new Promise<void>((resolve) => setTimeout(resolve, FLUSH_DRAIN_MS))
    const out = s.encodedQueue.splice(0)
    s.framesOut += out.length
    return out
  }

  // ── Inventory ────────────────────────────────────────────────────────────

  async listActiveSessions() {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      kind: s.kind,
      codec: s.config.codec,
      sourceSampleRate: s.config.sourceSampleRate,
      sourceChannels: s.config.sourceChannels,
      targetSampleRate: s.config.targetSampleRate,
      targetChannels: s.config.targetChannels,
      format: this.resolveFormat(s),
      ...(s.tag ? { tag: s.tag } : {}),
      createdAtMs: s.createdAtMs,
      lastActivityMs: s.lastActivityMs,
      framesIn: s.framesIn,
      framesOut: s.framesOut,
    }))
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private spawnDecodeSession(s: DecodeSessionState): NodeAvAudioDecodeSession {
    return new NodeAvAudioDecodeSession(
      this.deps.runtime,
      {
        codec: s.config.codec,
        sourceSampleRate: s.config.sourceSampleRate,
        sourceChannels: s.config.sourceChannels,
        ...(s.config.extraData ? { extraData: s.config.extraData } : {}),
        targetSampleRate: s.config.targetSampleRate,
        targetChannels: s.config.targetChannels,
        targetFormat: this.pcmFormat(s.config.targetFormat),
      },
      this.deps.logger,
      (chunk) => {
        s.pcmQueue.push(chunk)
        if (s.pcmQueue.length > MAX_PCM_QUEUE_CHUNKS) {
          s.pcmQueue.splice(0, s.pcmQueue.length - MAX_PCM_QUEUE_CHUNKS)
        }
      },
    )
  }

  private spawnEncodeSession(s: EncodeSessionState): NodeAvAudioEncodeSession {
    return new NodeAvAudioEncodeSession(
      this.deps.runtime,
      {
        codec: s.config.codec,
        sourceSampleRate: s.config.sourceSampleRate,
        sourceChannels: s.config.sourceChannels,
        sourceFormat: this.pcmFormat(s.config.sourceFormat),
        targetSampleRate: s.config.targetSampleRate,
        targetChannels: s.config.targetChannels,
        ...(s.config.bitrateKbps !== undefined ? { bitrateKbps: s.config.bitrateKbps } : {}),
      },
      this.deps.logger,
      (chunk) => {
        s.encodedQueue.push(chunk)
        if (s.encodedQueue.length > MAX_ENCODED_QUEUE_CHUNKS) {
          s.encodedQueue.splice(0, s.encodedQueue.length - MAX_ENCODED_QUEUE_CHUNKS)
        }
      },
    )
  }

  private pcmFormat(format: PcmSampleFormat | undefined): AudioPcmFormat {
    return format === 'f32le' ? 'f32le' : 's16le'
  }

  private resolveFormat(s: SessionState): PcmSampleFormat {
    if (s.kind === 'decode') return this.pcmFormat(s.config.targetFormat)
    return this.pcmFormat(s.config.sourceFormat)
  }

  private reapIdleSessions(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      const limit = s.config.idleMs ?? DEFAULT_IDLE_MS
      if (now - s.lastActivityMs > limit) {
        this.deps.logger.info('audio-codec-nodeav: reaping idle session', {
          tags: { sessionId: id },
          meta: { kind: s.kind, idleMs: now - s.lastActivityMs, limit },
        })
        try {
          this.disposeSession(s)
        } catch (err) {
          this.deps.logger.warn('audio-codec-nodeav: dispose failed during reap', {
            tags: { sessionId: id },
            meta: { error: errMsg(err) },
          })
        }
        this.sessions.delete(id)
      }
    }
  }

  private disposeSession(s: SessionState): void {
    try {
      s.session?.destroy()
    } catch (err) {
      this.deps.logger.warn('audio-codec-nodeav: session destroy failed', {
        tags: { sessionId: s.sessionId },
        meta: { error: errMsg(err) },
      })
    }
    s.session = null
  }
}
