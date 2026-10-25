/* eslint-disable @typescript-eslint/no-unsafe-assignment -- test router callers cross typed boundaries */
/**
 * protectedProcedure × device-config secrets — the tier test.
 *
 * Measured on the live hub before this gate existed: a scoped token
 * holding nothing but `category:system` + `view` (a READ-ONLY, non-admin grant)
 * read `deviceManager.getDevice` and received the camera's `config.password` in
 * plaintext, and `deviceManager.listAll` returned a populated password for every
 * camera in the deployment. Read-only must not mean credential disclosure.
 *
 * The gate lives in the middleware because that is the only layer that knows
 * the principal: in-process callers (`ctx.api`, the pipeline orchestrator's
 * per-camera `getDevice`) never pass through it and keep the real config.
 *
 * Admins are asserted UNCHANGED — the settings form needs the value to render,
 * and `updateConfig` is admin-only, so nothing round-trips a redacted value.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { REDACTED_SECRET } from '../device-config-secret-redaction.js'
import type { AuthenticatedAgent, TrpcContext } from '../trpc.context.js'
import { protectedProcedure, trpcRouter } from '../trpc.middleware.js'

const PLAINTEXT = 'camera-pw-fixture'
// A camera credential embedded in an RTSP URL (userinfo), distinct from the
// config-blob password fixture.
const CAMERA_PW = 'rtsp-pw-fixture'

const row = (id: number): Record<string, unknown> => ({
  id,
  name: `cam-${id}`,
  online: true,
  config: { host: '192.168.10.139', username: 'operator', password: PLAINTEXT, port: 80 },
})

const testRouter = trpcRouter({
  deviceManager: trpcRouter({
    getDevice: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .query(({ input }) => row(input.deviceId)),
    listAll: protectedProcedure.input(z.object({}).optional()).query(() => [row(101), row(102)]),
    getDeviceSettingsAggregate: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .query(() => ({
        sections: [
          {
            id: 'connection',
            fields: [
              { key: 'host', value: '192.168.10.139', type: 'text' },
              { key: 'password', value: PLAINTEXT, type: 'password' },
            ],
          },
        ],
      })),
    // A device-manager read that carries NO config — must pass through
    // byte-for-byte, so the projection cannot be blamed for a shape change.
    listLocations: protectedProcedure.input(z.void()).query(() => ['front door', 'garden']),
  }),
  // A non-device-manager cap whose response legitimately carries a credential
  // the CALLER needs (TURN). The projection must not touch it.
  turnProvider: trpcRouter({
    getTurnServers: protectedProcedure
      .input(z.void())
      .query(() => [{ urls: 'turn:h:3478', username: 'u', credential: 'turn-cred' }]),
  }),
  // F0.3 — RTSP restream surface. Returns `rtsp://user:pass@host` verbatim; a
  // read-only token reaching it could open the camera by copy-paste.
  cameraStreams: trpcRouter({
    getRtspEntries: protectedProcedure.input(z.object({ deviceId: z.number() })).query(() => [
      {
        brokerId: '101/high',
        url: `rtsp://admin:${CAMERA_PW}@192.168.10.139:554/Streaming/Channels/101`,
        mutedUrl: `rtsp://admin:${CAMERA_PW}@192.168.10.139:554/Streaming/Channels/101?muted=1`,
        enabled: true,
      },
    ]),
  }),
})

function makeUser(over: Partial<AuthenticatedAgent>): AuthenticatedAgent {
  return {
    id: 'u-1',
    username: 'token:ci',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: true,
    scopes: [{ type: 'category', target: 'system', access: ['view'] }],
    ...over,
  }
}

/**
 * A read-only operator over the WHOLE fleet: `category:system[view]` for the
 * device-manager surface plus an `all` device selector.
 *
 * The device grant is not decoration — since F1 #3 a system-scope method that
 * NAMES a device (`getDevice({deviceId})`) also requires device reach, so a
 * `category:system`-only token is refused before it ever reaches the provider.
 * This spec is about REDACTION (a caller who may legitimately read the device
 * still must not receive its password), so the caller is given the reach that
 * lets the redaction path actually run.
 */
const systemViewToken = (): AuthenticatedAgent =>
  makeUser({
    scopes: [
      { type: 'category', target: 'system', access: ['view'] },
      { type: 'device', selector: { kind: 'all' }, access: ['view'] },
    ],
  })

const admin = (): AuthenticatedAgent =>
  makeUser({
    id: 'u-admin',
    username: 'root',
    isAdmin: true,
    permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    scopes: ['*'],
  })

const shareUser = (): AuthenticatedAgent =>
  makeUser({
    username: 'token:share grid-view',
    scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [101] } }],
  })

function makeCaller(user: AuthenticatedAgent | null) {
  const ctx: TrpcContext = { user }
  return testRouter.createCaller(ctx)
}

describe('non-admin callers never receive a device credential', () => {
  it('getDevice — the scoped read-only token gets a redacted password', async () => {
    const out = await makeCaller(systemViewToken()).deviceManager.getDevice({ deviceId: 101 })
    const cfg = (out as { config: Record<string, unknown> }).config
    expect(cfg['password']).toBe(REDACTED_SECRET)
    expect(cfg['password']).not.toBe(PLAINTEXT)
    // Everything the caller legitimately asked for survives.
    expect(cfg['host']).toBe('192.168.10.139')
    expect(cfg['username']).toBe('operator')
    expect((out as { name: string }).name).toBe('cam-101')
  })

  it('listAll — no row in the whole-fleet listing carries a plaintext credential', async () => {
    const out = await makeCaller(systemViewToken()).deviceManager.listAll({})
    const rows = out as { config: Record<string, unknown> }[]
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain(PLAINTEXT)
    for (const r of rows) expect(r.config['password']).toBe(REDACTED_SECRET)
  })

  it('the settings aggregate is redacted too — the form is not a side door', async () => {
    const out = await makeCaller(systemViewToken()).deviceManager.getDeviceSettingsAggregate({
      deviceId: 101,
    })
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT)
  })

  it('a config-free device-manager read is untouched', async () => {
    const out = await makeCaller(systemViewToken()).deviceManager.listLocations()
    expect(out).toEqual(['front door', 'garden'])
  })

  it('a credential the CALLER owns (TURN) is not redacted', async () => {
    const out = await makeCaller(systemViewToken()).turnProvider.getTurnServers()
    expect((out as { credential: string }[])[0]!.credential).toBe('turn-cred')
  })

  it('getRtspEntries — the RTSP URL userinfo is masked for a read-only token (F0.3)', async () => {
    // A `category:device [view]` token: allowed to READ the stream list, not to
    // receive the camera credential baked into the restream URL.
    const deviceViewToken = makeUser({
      scopes: [{ type: 'category', target: 'device', access: ['view'] }],
    })
    const out = await makeCaller(deviceViewToken).cameraStreams.getRtspEntries({ deviceId: 101 })
    const rows = out as { url: string; mutedUrl: string }[]
    expect(JSON.stringify(rows)).not.toContain(CAMERA_PW)
    expect(rows[0]!.url).toBe('rtsp://192.168.10.139:554/Streaming/Channels/101')
    expect(rows[0]!.mutedUrl).toBe('rtsp://192.168.10.139:554/Streaming/Channels/101?muted=1')
  })
})

describe('admins are unaffected — the settings form still renders the value', () => {
  it('getDevice returns the real config', async () => {
    const out = await makeCaller(admin()).deviceManager.getDevice({ deviceId: 101 })
    expect((out as { config: Record<string, unknown> }).config['password']).toBe(PLAINTEXT)
  })

  it('the settings aggregate returns the real value', async () => {
    const out = await makeCaller(admin()).deviceManager.getDeviceSettingsAggregate({
      deviceId: 101,
    })
    expect(JSON.stringify(out)).toContain(PLAINTEXT)
  })
})

describe('share-view principals keep their own, stricter projection', () => {
  it('getDevice stays FORBIDDEN — the allowlist, not the redactor, is their gate', async () => {
    await expect(
      makeCaller(shareUser()).deviceManager.getDevice({ deviceId: 101 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
