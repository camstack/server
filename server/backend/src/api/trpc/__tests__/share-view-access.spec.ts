import { describe, expect, it } from 'vitest'
import type { ShareViewGrant } from '@camstack/types'
import {
  checkShareViewAccess,
  liveEventInShareScope,
  projectListAllForShareScope,
  projectShareScopeRows,
} from '../share-view-access.js'

/**
 * Share-view allowlist checker — the fail-closed gate for share-link
 * tokens. Everything not explicitly enumerated is denied; device-input
 * methods additionally require an in-scope `input.deviceId`.
 */

const SCOPE: ShareViewGrant = { kind: 'grid-view', deviceIds: [5, 7] }

describe('checkShareViewAccess', () => {
  describe('open methods (no device input)', () => {
    it.each([
      'auth.me',
      'deviceManager.listAll',
      'turnProvider.getTurnServers',
      'live.onEvent',
    ])('allows %s', (path) => {
      expect(checkShareViewAccess(SCOPE, path)).toEqual({ ok: true })
    })
  })

  describe('device-gated methods', () => {
    const DEVICE_METHODS = [
      'snapshot.getSnapshot',
      'pipelineOrchestrator.getCameraMetrics',
      'webrtcSession.listStreams',
      'webrtcSession.createSession',
      'webrtcSession.handleOffer',
      'webrtcSession.handleAnswer',
      'webrtcSession.addIceCandidate',
      'webrtcSession.getIceCandidates',
      'webrtcSession.getSessionState',
      'webrtcSession.closeSession',
    ]

    it.each(DEVICE_METHODS)('allows %s for an in-scope device', (path) => {
      expect(checkShareViewAccess(SCOPE, path, { deviceId: 5 })).toEqual({ ok: true })
      expect(checkShareViewAccess(SCOPE, path, { deviceId: 7, sessionId: 's1' })).toEqual({
        ok: true,
      })
    })

    it.each(DEVICE_METHODS)('denies %s for an out-of-scope device', (path) => {
      const result = checkShareViewAccess(SCOPE, path, { deviceId: 42 })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/outside this share link/)
    })

    it('denies a device method with a missing deviceId (fail closed)', () => {
      expect(checkShareViewAccess(SCOPE, 'snapshot.getSnapshot', {}).ok).toBe(false)
      expect(checkShareViewAccess(SCOPE, 'snapshot.getSnapshot', undefined).ok).toBe(false)
      expect(checkShareViewAccess(SCOPE, 'snapshot.getSnapshot', null).ok).toBe(false)
    })

    it('denies a device method with a non-numeric deviceId (no string coercion)', () => {
      expect(checkShareViewAccess(SCOPE, 'snapshot.getSnapshot', { deviceId: '5' }).ok).toBe(false)
      expect(checkShareViewAccess(SCOPE, 'snapshot.getSnapshot', { deviceId: NaN }).ok).toBe(false)
    })
  })

  describe('everything else is denied (fail closed)', () => {
    it.each([
      // Neighbouring methods on allowlisted routers.
      'snapshot.invalidateCache',
      'webrtcSession.hasAdaptiveBitrate',
      'deviceManager.remove',
      'live.recentSystemEvents',
      'live.onDeviceEvent',
      // Sensitive surfaces that must never be reachable from a share link.
      // `intercom.startSession` used to be here. It is no longer NEVER
      // reachable — it is not reachable without `scope.talk`, which is a
      // different claim and is pinned in the talk-back block below, with its
      // own refusal reason. Kept out of this list rather than loosened inside
      // it: a list called "never" that means "usually" is worse than no list.
      'recording.getPlaybackManifest',
      'auth.createShareToken',
      'auth.listShareTokens',
      'auth.login',
      'auth.changeOwnPassword',
      'userMgmt.listUsers',
      'addons.install',
      'systemConfig.set',
      // Unknown / made-up paths.
      'totally.madeUp',
    ])('denies %s even with an in-scope deviceId', (path) => {
      const result = checkShareViewAccess(SCOPE, path, { deviceId: 5 })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/not available to share-view/)
    })
  })
})

describe('liveEventInShareScope', () => {
  const allowed: ReadonlySet<number> = new Set([5, 7])

  it('passes device-sourced events with a numeric in-scope source.id', () => {
    expect(liveEventInShareScope({ source: { type: 'device', id: 5 }, data: {} }, allowed)).toBe(
      true,
    )
  })

  it('passes device-sourced events with a string-typed in-scope source.id', () => {
    expect(liveEventInShareScope({ source: { type: 'device', id: '7' }, data: {} }, allowed)).toBe(
      true,
    )
  })

  it('passes addon-sourced per-device telemetry via data.deviceId', () => {
    expect(
      liveEventInShareScope(
        { source: { type: 'addon', id: 'pipeline-runner' }, data: { deviceId: 5 } },
        allowed,
      ),
    ).toBe(true)
  })

  it('drops events for out-of-scope devices', () => {
    expect(liveEventInShareScope({ source: { type: 'device', id: 42 }, data: {} }, allowed)).toBe(
      false,
    )
    expect(
      liveEventInShareScope(
        { source: { type: 'addon', id: 'x' }, data: { deviceId: 42 } },
        allowed,
      ),
    ).toBe(false)
  })

  it('drops unattributable events (fail closed)', () => {
    expect(
      liveEventInShareScope({ source: { type: 'system', id: 'hub' }, data: {} }, allowed),
    ).toBe(false)
    expect(liveEventInShareScope({}, allowed)).toBe(false)
    expect(liveEventInShareScope({ data: { deviceId: 'not-a-number' } }, allowed)).toBe(false)
  })
})

describe('projectListAllForShareScope', () => {
  const device = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: `cam-${id}`,
    online: true,
    isCamera: true,
    type: 'camera',
    location: null,
    disabled: false,
    stableId: `vendor:${id}`,
    addonId: 'provider-x',
    config: { connection: { host: '10.0.0.1', password: 'hunter2' } },
    ...extra,
  })

  it('drops devices outside the share scope', () => {
    const out = projectListAllForShareScope([device(5), device(6), device(7)], SCOPE)
    expect(Array.isArray(out)).toBe(true)
    const rows = out as ReadonlyArray<{ id: number }>
    expect(rows.map((r) => r.id)).toEqual([5, 7])
  })

  it('strips every non-whitelisted field — config/credentials never leak', () => {
    const out = projectListAllForShareScope([device(5)], SCOPE) as ReadonlyArray<
      Record<string, unknown>
    >
    expect(out[0]).toEqual({
      id: 5,
      name: 'cam-5',
      online: true,
      isCamera: true,
      type: 'camera',
      location: null,
      disabled: false,
    })
    expect(out[0]).not.toHaveProperty('config')
    expect(out[0]).not.toHaveProperty('stableId')
    expect(out[0]).not.toHaveProperty('addonId')
  })

  it('passes non-array payloads through untouched (defensive)', () => {
    expect(projectListAllForShareScope(null, SCOPE)).toBe(null)
    expect(projectListAllForShareScope({ weird: true }, SCOPE)).toEqual({ weird: true })
  })

  it('skips rows without a numeric id (fail closed)', () => {
    const out = projectListAllForShareScope(
      [device(5), { name: 'no-id' }, { id: 'seven' }],
      SCOPE,
    ) as ReadonlyArray<{ id: number }>
    expect(out.map((r) => r.id)).toEqual([5])
  })
})

// ── events-view: the events embed's surface ─────────────────────────────────
//
// A SEPARATE scope kind, not an extension of `grid-view`. Adding the track
// methods to `grid-view` would retroactively widen every share link an
// operator has already handed out — a link minted to show a camera wall would
// silently start serving that camera's event history. Old tokens must keep the
// perimeter they were minted with.

const EVENTS_SCOPE: ShareViewGrant = { kind: 'events-view', deviceIds: [5, 7] }

describe('checkShareViewAccess — events-view', () => {
  it('keeps the boot surface a shared page needs', () => {
    expect(checkShareViewAccess(EVENTS_SCOPE, 'auth.me')).toEqual({ ok: true })
    expect(checkShareViewAccess(EVENTS_SCOPE, 'deviceManager.listAll')).toEqual({ ok: true })
  })

  describe('listRecentTracks — an ARRAY input, so the rule is INTERSECTION', () => {
    it('allows a request whose devices are all in scope', () => {
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listRecentTracks', {
          deviceIds: [5, 7],
        }),
      ).toEqual({ ok: true })
    })

    it('allows a PARTIALLY in-scope request — filter and serve', () => {
      // Filter-and-serve, not reject: a multi-camera link whose owner removed
      // one camera from the share must keep working for the rest. The rows for
      // the out-of-scope device are stripped from the RESPONSE.
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listRecentTracks', {
          deviceIds: [5, 42],
        }),
      ).toEqual({ ok: true })
    })

    it('DENIES a fully disjoint request', () => {
      // Nothing to serve, and answering `[]` would read as "this camera has no
      // events" rather than "you cannot see this camera".
      const r = checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listRecentTracks', {
        deviceIds: [42, 43],
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/outside this share link/)
    })

    it('denies a missing or malformed deviceIds (fail closed)', () => {
      expect(checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listRecentTracks', {}).ok).toBe(
        false,
      )
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listRecentTracks', {
          deviceIds: [],
        }).ok,
      ).toBe(false)
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listRecentTracks', undefined).ok,
      ).toBe(false)
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listRecentTracks', {
          deviceIds: 'all',
        }).ok,
      ).toBe(false)
    })
  })

  describe('listEventKindsBatch — the same array rule', () => {
    it('allows an in-scope or partially in-scope batch', () => {
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listEventKindsBatch', {
          deviceIds: [5],
        }),
      ).toEqual({ ok: true })
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listEventKindsBatch', {
          deviceIds: [7, 42],
        }),
      ).toEqual({ ok: true })
    })

    it('denies a disjoint batch', () => {
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.listEventKindsBatch', {
          deviceIds: [42],
        }).ok,
      ).toBe(false)
    })
  })

  describe('searchObjectEvents — an OPTIONAL single deviceId that means EVERYWHERE', () => {
    it('allows an in-scope deviceId', () => {
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.searchObjectEvents', {
          text: 'car',
          deviceId: 5,
        }),
      ).toEqual({ ok: true })
    })

    it('denies an out-of-scope deviceId', () => {
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.searchObjectEvents', {
          text: 'car',
          deviceId: 42,
        }).ok,
      ).toBe(false)
    })

    it('ALLOWS an omitted deviceId — the response is scoped server-side', () => {
      // Omitting it searches every camera in the deployment. That is exactly
      // why the answer cannot be trusted to the caller: the call passes and the
      // RESULT is filtered to the scope (see projectShareScopeRows). Rejecting
      // it instead would leave a multi-camera share link unable to search at
      // all, and would not be safer — the filter is what makes it safe.
      expect(
        checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.searchObjectEvents', {
          text: 'car',
        }),
      ).toEqual({ ok: true })
    })
  })

  it('does NOT grant the grid surface — an events link is not a camera wall', () => {
    for (const path of [
      'snapshot.getSnapshot',
      'webrtcSession.createSession',
      'turnProvider.getTurnServers',
      'pipelineOrchestrator.getCameraMetrics',
    ]) {
      expect(checkShareViewAccess(EVENTS_SCOPE, path, { deviceId: 5 }).ok).toBe(false)
    }
  })

  it('still denies everything outside both enumerations', () => {
    expect(checkShareViewAccess(EVENTS_SCOPE, 'auth.logout').ok).toBe(false)
    expect(checkShareViewAccess(EVENTS_SCOPE, 'recording.getClip', { deviceId: 5 }).ok).toBe(false)
    expect(
      checkShareViewAccess(EVENTS_SCOPE, 'pipelineAnalytics.deleteTracks', { deviceId: 5 }).ok,
    ).toBe(false)
  })
})

describe('an EXISTING grid-view token gains nothing', () => {
  // The whole reason events-view is its own kind: a link an operator handed
  // out to show a camera wall must not silently start serving event history.
  it.each([
    'pipelineAnalytics.listRecentTracks',
    'pipelineAnalytics.listEventKindsBatch',
    'pipelineAnalytics.searchObjectEvents',
  ])('denies %s to a grid-view token', (path) => {
    const r = checkShareViewAccess(SCOPE, path, { deviceIds: [5], deviceId: 5, text: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not available to share-view tokens/)
  })
})

describe('projectShareScopeRows', () => {
  const rows = [
    { trackId: 'a', deviceId: 5 },
    { trackId: 'b', deviceId: 42 },
    { trackId: 'c', deviceId: 7 },
  ]

  it('strips rows for devices outside the scope', () => {
    expect(projectShareScopeRows(rows, EVENTS_SCOPE)).toEqual([
      { trackId: 'a', deviceId: 5 },
      { trackId: 'c', deviceId: 7 },
    ])
  })

  it('unwraps and re-wraps a PAGED response, preserving the cursor', () => {
    // `listRecentTracks` answers `{tracks, nextCursor}`; dropping the cursor
    // would silently end the shared page's infinite scroll at page one.
    const page = { tracks: rows, nextCursor: 'cur-1' }
    expect(projectShareScopeRows(page, EVENTS_SCOPE)).toEqual({
      tracks: [
        { trackId: 'a', deviceId: 5 },
        { trackId: 'c', deviceId: 7 },
      ],
      nextCursor: 'cur-1',
    })
  })

  it('drops a row with NO deviceId — fail closed, never "probably fine"', () => {
    expect(
      projectShareScopeRows([{ trackId: 'x' }, { trackId: 'a', deviceId: 5 }], EVENTS_SCOPE),
    ).toEqual([{ trackId: 'a', deviceId: 5 }])
  })

  it('passes a non-row payload through untouched', () => {
    expect(projectShareScopeRows(null, EVENTS_SCOPE)).toBeNull()
    expect(projectShareScopeRows('nope', EVENTS_SCOPE)).toBe('nope')
  })

  it('is the same filter for a grid scope — it reads deviceIds, not the kind', () => {
    expect(projectShareScopeRows(rows, SCOPE)).toHaveLength(2)
  })
})

/**
 * TALK-BACK is opt-in PER TOKEN, and absent means off.
 *
 * ## Why not simply allowlisted (operator, 2026-09-16: "si abilita l'intercom su ha" [the intercom is enabled on ha])
 *
 * Because a share token is handed to third parties, and this module's own
 * docblock says what happens if you widen the enumeration: "a `grid-view` link
 * an operator handed out last week must not silently start serving event
 * history because a new surface shipped". Talk-back is that rule with the stake
 * raised — not reading something extra, but SPEAKING INTO THE HOUSE. Adding
 * `intercom.*` to the grid enumeration would hand that to every link ever
 * minted, retroactively and silently.
 *
 * So it rides on the scope: the integration that wants it mints for it, and a
 * token without the flag is exactly the token it was the day it was minted.
 */
const TALK_METHODS = [
  'intercom.startSession',
  'intercom.handleAnswer',
  'intercom.stopSession',
] as const

describe('talk-back', () => {
  const noTalk: ShareViewGrant = { kind: 'grid-view', deviceIds: [5, 7] }
  const withTalk: ShareViewGrant = { kind: 'grid-view', deviceIds: [5, 7], talk: true }

  it.each(TALK_METHODS)('denies %s on a token that did not ask for it', (path) => {
    expect(checkShareViewAccess(noTalk, path, { deviceId: 5 }).ok).toBe(false)
  })

  it.each(TALK_METHODS)('allows %s on a token minted with talk', (path) => {
    expect(checkShareViewAccess(withTalk, path, { deviceId: 5 })).toEqual({ ok: true })
  })

  it('still confines talk to the token’s own devices', () => {
    // The flag widens WHAT may be called, never WHICH cameras. A talk token for
    // the kitchen must not speak into the bedroom.
    expect(checkShareViewAccess(withTalk, 'intercom.startTalkSession', { deviceId: 999 }).ok).toBe(
      false,
    )
    expect(checkShareViewAccess(withTalk, 'intercom.startTalkSession', {}).ok).toBe(false)
  })

  it('does NOT open the rest of intercom, nor anything else', () => {
    // Enumerated, never `intercom.*`: the push-talk triple is a different
    // surface and this flag does not grant it. The first cut granted THAT one
    // and not the flow the embed runs, so the flag would have changed nothing.
    expect(checkShareViewAccess(withTalk, 'intercom.startTalkSession', { deviceId: 5 }).ok).toBe(
      false,
    )
    expect(checkShareViewAccess(withTalk, 'recording.start', { deviceId: 5 }).ok).toBe(false)
  })

  it('never reaches an events-view token', () => {
    const events: ShareViewGrant = { kind: 'events-view', deviceIds: [5], talk: true }
    expect(checkShareViewAccess(events, 'intercom.startTalkSession', { deviceId: 5 }).ok).toBe(
      false,
    )
  })
})
