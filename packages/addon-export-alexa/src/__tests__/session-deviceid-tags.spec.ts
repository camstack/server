/**
 * Verifies the queryable-tag contract for Alexa live-view sessions:
 *
 *  - `handleInitiateSessionWithOffer` binds a child logger with the
 *    camera `deviceId` + `sessionId` in `tags` (the greppable column),
 *    so every entry in the session is filterable by `tags.deviceId`.
 *  - The `/directive` arrival log carries the target camera's `deviceId`
 *    in `tags` for device-targeted directives (live-view, stream-init,
 *    control) and omits it for endpoint-less directives (discovery/auth).
 *
 * These guard the prior regression where `deviceId` lived only in
 * free-form `meta` and was therefore not queryable.
 */
import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { handleInitiateSessionWithOffer, type RtcSessionContext } from '../handlers/rtc-session.js'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { describeDirectiveArrival } from '../http-server.js'

interface RecordedCall {
  readonly message: string
  readonly extras?: LogExtras
}

// A minimal recording logger that tracks `withTags` bindings and the
// extras passed to every method. `withTags` returns a child whose bound
// tags are merged into the child's recorded calls — mirroring the real
// IScopedLogger so a session log can be asserted by its `tags`. The
// `logger` member is typed as the real `IScopedLogger`, so no cast is
// needed at the call site.
function makeRecordingLogger(boundTags: LogTags = {}) {
  const withTagsCalls: LogTags[] = []
  const calls: RecordedCall[] = []
  const record = (message: string, extras?: LogExtras): void => {
    const mergedTags: LogTags = { ...boundTags, ...extras?.tags }
    calls.push({ message, extras: { tags: mergedTags, meta: extras?.meta } })
  }
  const logger: IScopedLogger = {
    info: record,
    warn: record,
    error: record,
    debug: record,
    child: () => logger,
    withTags: (tags: LogTags) => {
      withTagsCalls.push(tags)
      return makeRecordingLogger({ ...boundTags, ...tags }).logger
    },
  }
  return { logger, calls, withTagsCalls }
}

// The exact `ctx.api` surface the rtc-session handler dereferences for
// this scenario. Typing the stub against this minimal interface (whose
// leaf shapes a `vi.fn()` satisfies) means the only boundary to the full
// generated `AddonApi` is a single documented `as` on `ctx` below — never
// an `as unknown as`.
interface RtcStubApi {
  readonly battery: {
    readonly getStatus: { readonly query: (args: unknown) => Promise<unknown> }
    readonly wakeForStream: { readonly mutate: (args: unknown) => Promise<unknown> }
  }
  readonly cameraStreams: {
    readonly pickStream: { readonly query: (args: unknown) => Promise<unknown> }
  }
  readonly webrtcSession: {
    readonly handleOffer: { readonly mutate: (args: unknown) => Promise<unknown> }
  }
}

const HEADER = {
  namespace: 'Alexa.RTCSessionController',
  name: 'InitiateSessionWithOffer',
  payloadVersion: '3',
  messageId: 'msg-1',
}

const IDENTITY: VerifiedDirectiveIdentity = {
  userId: 'user-1',
  username: 'tester',
  scopes: [{ type: 'category', target: 'device', access: ['view'] }],
}

describe('Alexa session deviceId log-tagging', () => {
  it('binds deviceId + sessionId in tags for the live-view session logger', async () => {
    const recorder = makeRecordingLogger()
    // ctx.api stub: no battery cap, pickStream throws (→ warn via the
    // bound child logger), keeping the path deterministic without the
    // derived-broker egress module.
    const api: RtcStubApi = {
      battery: {
        getStatus: { query: vi.fn().mockResolvedValue(null) },
        wakeForStream: { mutate: vi.fn().mockResolvedValue({ awoke: false, durationMs: 0 }) },
      },
      cameraStreams: {
        pickStream: { query: vi.fn().mockRejectedValue(new Error('boom')) },
      },
      webrtcSession: {
        handleOffer: { mutate: vi.fn().mockRejectedValue(new Error('offer-fail')) },
      },
    }
    // Single documented test-stub boundary: the minimal consumed-api
    // surface widens to the full `AddonContext`. No `as unknown as`.
    const ctx = { api } as RtcSessionContext['ctx']

    const deps: RtcSessionContext = {
      ctx,
      logger: recorder.logger,
      listExposed: () => [],
    }

    await handleInitiateSessionWithOffer(
      HEADER,
      { endpointId: '7', scope: { type: 'BearerToken', token: 'tok' } },
      {
        sessionId: 'sess-abc',
        offer: { value: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', format: 'SDP' },
      },
      deps,
      IDENTITY,
    )

    // The child logger was bound with deviceId + sessionId in tags.
    expect(recorder.withTagsCalls).toContainEqual({ deviceId: 7, sessionId: 'sess-abc' })
  })

  it('arrival parse exposes the camera deviceId for a device-targeted directive', () => {
    const info = describeDirectiveArrival({
      directive: {
        header: { namespace: 'Alexa.RTCSessionController', name: 'InitiateSessionWithOffer' },
        endpoint: { endpointId: '42' },
      },
    })
    expect(info).toEqual({
      namespace: 'Alexa.RTCSessionController',
      name: 'InitiateSessionWithOffer',
      endpointId: '42',
      deviceId: 42,
    })
  })

  it('arrival parse omits deviceId for an endpoint-less directive (discovery)', () => {
    const info = describeDirectiveArrival({
      directive: { header: { namespace: 'Alexa.Discovery', name: 'Discover' } },
    })
    expect(info).toEqual({ namespace: 'Alexa.Discovery', name: 'Discover' })
    expect(info.deviceId).toBeUndefined()
  })

  it('arrival parse stays defensive for a child-accessory endpoint (no camera deviceId)', () => {
    const info = describeDirectiveArrival({
      directive: {
        header: { namespace: 'Alexa.PowerController', name: 'TurnOn' },
        endpoint: { endpointId: '42__7' },
      },
    })
    // A `parent__child` endpoint is not a bare camera id → endpointId kept
    // for context, but no deviceId tag (no throw).
    expect(info.endpointId).toBe('42__7')
    expect(info.deviceId).toBeUndefined()
  })
})
