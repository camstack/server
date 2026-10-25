/**
 * Thin tRPC-backed proxy for the `audio-codec` capability — the broker
 * uses this to decode AAC / opus / pcm_alaw / pcm_mulaw audio into PCM
 * for downstream subscribers (audio-analyzer, WebRTC audio leg, …).
 *
 * The cap is a system singleton; one provider serves all brokers on the
 * cluster. Plumbing here is a pass-through to `ctx.api.audioCodec.*` —
 * the broker doesn't know whether the audio decode runs locally or on a
 * remote node, the cap router resolves it.
 */
import type {
  AudioDecodeSessionConfig,
  AudioPcmChunk,
  AudioEncodeSessionConfig,
  AudioEncodedChunk,
  AudioCodecInfo,
} from '@camstack/types'

// Session-bound methods accept an optional `nodeId` so callers can pin
// every call to the node that owns the session. The generated cap router
// auto-routes any input field literally named `nodeId` to that node's
// provider — sessions are process-local, so without sticky routing the
// round-robin across nodes serves "session not found" on every other call.

export interface AudioCodecCapApi {
  listSupportedCodecs(): Promise<readonly AudioCodecInfo[]>
  canHandle(input: { codec: string; kind: 'decode' | 'encode' }): Promise<boolean>
  createDecodeSession(
    input: AudioDecodeSessionConfig,
  ): Promise<{ sessionId: string; nodeId: string }>
  createEncodeSession(
    input: AudioEncodeSessionConfig,
  ): Promise<{ sessionId: string; nodeId: string }>
  closeSession(input: { sessionId: string; nodeId?: string }): Promise<void>
  pushEncodedFrame(input: {
    sessionId: string
    nodeId?: string
    data: Uint8Array
    pts?: number
  }): Promise<void>
  pullPcm(input: {
    sessionId: string
    nodeId?: string
    maxCount: number
  }): Promise<readonly AudioPcmChunk[]>
  pushPcm(input: {
    sessionId: string
    nodeId?: string
    data: Uint8Array
    pts?: number
  }): Promise<void>
  pullEncoded(input: {
    sessionId: string
    nodeId?: string
    maxCount: number
  }): Promise<readonly AudioEncodedChunk[]>
  flushEncode(input: { sessionId: string; nodeId?: string }): Promise<readonly AudioEncodedChunk[]>
}

interface AudioCodecRouter {
  listSupportedCodecs: { query: (input?: void) => Promise<readonly AudioCodecInfo[]> }
  canHandle: { query: (input: { codec: string; kind: 'decode' | 'encode' }) => Promise<boolean> }
  createDecodeSession: {
    mutate: (input: AudioDecodeSessionConfig) => Promise<{ sessionId: string; nodeId: string }>
  }
  createEncodeSession: {
    mutate: (input: AudioEncodeSessionConfig) => Promise<{ sessionId: string; nodeId: string }>
  }
  closeSession: { mutate: (input: { sessionId: string; nodeId?: string }) => Promise<void> }
  pushEncodedFrame: {
    mutate: (input: {
      sessionId: string
      nodeId?: string
      data: Uint8Array
      pts?: number
    }) => Promise<void>
  }
  pullPcm: {
    query: (input: {
      sessionId: string
      nodeId?: string
      maxCount: number
    }) => Promise<readonly AudioPcmChunk[]>
  }
  pushPcm: {
    mutate: (input: {
      sessionId: string
      nodeId?: string
      data: Uint8Array
      pts?: number
    }) => Promise<void>
  }
  pullEncoded: {
    query: (input: {
      sessionId: string
      nodeId?: string
      maxCount: number
    }) => Promise<readonly AudioEncodedChunk[]>
  }
  flushEncode: {
    mutate: (input: { sessionId: string; nodeId?: string }) => Promise<readonly AudioEncodedChunk[]>
  }
}

/**
 * Build a tRPC-backed `AudioCodecCapApi`. Returns `null` when the cap
 * isn't mounted (no audio-codec addon installed) so callers can fall
 * back to native PCMU/PCMA path or skip audio entirely.
 */
export function buildAudioCodecCapApi(api: unknown | null): AudioCodecCapApi | null {
  if (!api) return null
  const router = (api as Record<string, unknown>)['audioCodec'] as AudioCodecRouter | undefined
  if (!router) return null

  return {
    listSupportedCodecs: () => router.listSupportedCodecs.query(),
    canHandle: (input) => router.canHandle.query(input),
    createDecodeSession: (input) => router.createDecodeSession.mutate(input),
    createEncodeSession: (input) => router.createEncodeSession.mutate(input),
    closeSession: (input) => router.closeSession.mutate(input),
    pushEncodedFrame: (input) => router.pushEncodedFrame.mutate(input),
    pullPcm: (input) => router.pullPcm.query(input),
    pushPcm: (input) => router.pushPcm.mutate(input),
    pullEncoded: (input) => router.pullEncoded.query(input),
    flushEncode: (input) => router.flushEncode.mutate(input),
  }
}
