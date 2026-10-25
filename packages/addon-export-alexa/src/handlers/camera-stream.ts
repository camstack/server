/**
 * `Alexa.CameraStreamController/InitializeCameraStreams` handler.
 *
 * Alexa asks for an RTSP URL it can dial into an Echo Show. We pull
 * the camera's published RTSP restream URLs through the
 * `camera-streams` device cap (URLs already carry the RTSP token Mike
 * we configured) and return the first H.264 source we can find.
 *
 * Auth: the directive's `endpoint.scope.token` is a camstack JWT we
 * minted via /oauth/token (audience=alexa-access). Reject anything
 * else.
 */
import { z } from 'zod'
import {
  EndpointRefSchema,
  InitializeCameraStreamsPayloadSchema,
  type DirectiveHeader,
} from './types.js'
import { errorEnvelope, type AlexaErrorEnvelope } from './error-envelope.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { pickPreferredRtspEntry, type RtspEntryLike } from '@camstack/types'
import type { ExposedDeviceEntry } from '../types.js'
import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'

const InitializeCameraStreamsDirectiveSchema = z.object({
  header: z.object({
    namespace: z.literal('Alexa.CameraStreamController'),
    name: z.literal('InitializeCameraStreams'),
  }),
  endpoint: EndpointRefSchema,
  payload: InitializeCameraStreamsPayloadSchema,
})

const STREAM_EXPIRATION_MS = 5 * 60 * 1000
const STREAM_IDLE_TIMEOUT_S = 30

export interface CameraStreamContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  /**
   * Returns the operator's exposed-device list (with per-device export
   * settings, including `streamPreference`). Pulled from
   * `this.config.exposed` — owned by the addon, not by the cap router,
   * so multi-provider co-existence stays safe.
   */
  readonly listExposed: () => readonly ExposedDeviceEntry[]
}

export async function handleInitializeCameraStreams(
  header: DirectiveHeader,
  endpointRaw: unknown,
  payloadRaw: unknown,
  deps: CameraStreamContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const dirParse = InitializeCameraStreamsDirectiveSchema.safeParse({
    header: { namespace: header.namespace, name: header.name },
    endpoint: endpointRaw,
    payload: payloadRaw ?? {},
  })
  if (!dirParse.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `payload validation failed: ${dirParse.error.message}`,
    )
  }
  const endpoint = dirParse.data.endpoint

  // Token is already verified by the centralized entry check in
  // handleDirective (http-server.ts). No per-handler re-verification needed.

  const parsed = parseCameraEndpointId(endpoint.endpointId)
  if (parsed.kind !== 'camera') {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `endpointId ${endpoint.endpointId} is not a camera`,
    )
  }
  const deviceId = parsed.deviceId

  const api: AddonApi = deps.ctx.api
  const restreams = await api.cameraStreams.getProfileRtspEntries
    .query({ deviceId })
    .catch((err: unknown) => {
      deps.logger.warn('alexa camera-stream: getProfileRtspEntries failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return [] as ReadonlyArray<RtspEntryLike>
    })

  const exposedEntry = deps.listExposed().find((e) => e.deviceId === deviceId)
  const pref = exposedEntry?.settings?.streamPreference ?? 'auto'
  // Alexa's Smart Home camera stream spec tops out at 1080p but most
  // Echo devices request 720p — passing the typical Echo target makes
  // `pref === 'auto'` resolve to the camStream slot closest to it
  // (prefer ≥ target so the Echo can downscale instead of upscale, and
  // we don't dial the 4K slot for an Echo Show 5).
  const picked = pickPreferredRtspEntry(restreams, pref, deviceId, {
    targetResolution: { width: 1280, height: 720 },
  })
  if (!picked) {
    deps.logger.warn('alexa camera-stream: no enabled RTSP restream for device', {
      tags: { deviceId },
      meta: { pref },
    })
    return errorEnvelope(
      header,
      'STREAM_TYPE_UNSUPPORTED',
      `no enabled H.264 RTSP restream available for device ${deviceId}`,
    )
  }
  const enabled = picked

  return {
    event: {
      header: {
        namespace: 'Alexa.CameraStreamController',
        name: 'Response',
        messageId: header.messageId,
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: { endpointId: endpoint.endpointId },
      payload: {
        cameraStreams: [
          {
            uri: enabled.url,
            expirationTime: new Date(Date.now() + STREAM_EXPIRATION_MS).toISOString(),
            idleTimeoutSeconds: STREAM_IDLE_TIMEOUT_S,
            protocol: 'RTSP',
            resolution: { width: 1920, height: 1080 },
            authorizationType: 'BASIC',
            videoCodec: 'H264',
            audioCodec: 'AAC',
          },
        ],
      },
    },
  } satisfies CameraStreamResponse
}

interface CameraStreamResponse {
  readonly event: {
    readonly header: {
      readonly namespace: 'Alexa.CameraStreamController'
      readonly name: 'Response'
      readonly messageId: string
      readonly correlationToken?: string
      readonly payloadVersion: '3'
    }
    readonly endpoint: { readonly endpointId: string }
    readonly payload: {
      readonly cameraStreams: ReadonlyArray<{
        readonly uri: string
        readonly expirationTime: string
        readonly idleTimeoutSeconds: number
        readonly protocol: 'RTSP'
        readonly resolution: { readonly width: number; readonly height: number }
        readonly authorizationType: 'BASIC'
        readonly videoCodec: 'H264'
        readonly audioCodec: 'AAC'
      }>
    }
  }
}

export function notSupported(header: DirectiveHeader, message: string): AlexaErrorEnvelope {
  return errorEnvelope(header, 'INVALID_DIRECTIVE', message)
}
