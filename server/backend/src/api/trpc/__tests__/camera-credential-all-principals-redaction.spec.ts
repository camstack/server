/**
 * A camera's own login inside a stream URL is withheld from EVERY principal,
 * an admin included. Measured live: `streamCatalog.getCatalog` for a Reolink
 * camera answered admin callers with `flv` entries carrying `user=` and
 * `password=` in clear text.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ALL_PRINCIPALS_REDACTED_METHODS } from '../device-config-secret-redaction.js'
import type { AuthenticatedAgent, TrpcContext } from '../trpc.context.js'
import { protectedProcedure, trpcRouter } from '../trpc.middleware.js'

const CAMERA_PW = 'cam-pw-fixture-7f3'
const FLV = `http://192.0.2.10/flv?port=1935&app=bcs&stream=channel0_main.bcs&user=admin&password=${CAMERA_PW}`
const RTSP = `rtsp://admin:${CAMERA_PW}@192.0.2.10:554/h264Preview_01_main`

const catalog = [
  { camStreamId: 'flv:0:main', kind: 'pull-flv', url: FLV },
  { camStreamId: 'rtsp:0:main', kind: 'pull-rtsp', url: RTSP },
]

const router = trpcRouter({
  streamCatalog: trpcRouter({
    getCatalog: protectedProcedure.input(z.object({ deviceId: z.number() })).query(() => catalog),
  }),
  cameraStreams: trpcRouter({
    getCameraStreams: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .query(() => catalog),
  }),
  streamBroker: trpcRouter({
    listAllCameraStreams: protectedProcedure.input(z.void()).query(() => catalog),
  }),
  deviceState: trpcRouter({
    getCapSlice: protectedProcedure
      .input(z.object({ deviceId: z.number(), capName: z.string() }))
      .query(({ input }) =>
        input.capName === 'stream-catalog' ? { descriptors: catalog } : { note: RTSP },
      ),
    getSnapshot: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .query(() => ({ 'stream-catalog': { descriptors: catalog } })),
  }),
})

const admin: AuthenticatedAgent = {
  id: 'u-admin',
  username: 'root',
  isAdmin: true,
  permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
  isApiKey: false,
  scopes: ['*'],
}
const caller = () => router.createCaller({ user: admin } satisfies TrpcContext)

describe('an admin never reads a camera credential from a stream catalog', () => {
  it('streamCatalog.getCatalog', async () => {
    const out = JSON.stringify(await caller().streamCatalog.getCatalog({ deviceId: 618 }))
    expect(out).not.toContain(CAMERA_PW)
    expect(out).toContain('flv:0:main')
  })
  it('cameraStreams.getCameraStreams and streamBroker.listAllCameraStreams', async () => {
    expect(
      JSON.stringify(await caller().cameraStreams.getCameraStreams({ deviceId: 618 })),
    ).not.toContain(CAMERA_PW)
    expect(JSON.stringify(await caller().streamBroker.listAllCameraStreams())).not.toContain(
      CAMERA_PW,
    )
  })
  it('the stream-catalog runtime-state slice, and only that slice', async () => {
    const slice = await caller().deviceState.getCapSlice({
      deviceId: 618,
      capName: 'stream-catalog',
    })
    expect(JSON.stringify(slice)).not.toContain(CAMERA_PW)
    const snap = await caller().deviceState.getSnapshot({ deviceId: 618 })
    expect(JSON.stringify(snap)).not.toContain(CAMERA_PW)
    const other = await caller().deviceState.getCapSlice({
      deviceId: 618,
      capName: 'other',
    })
    expect(JSON.stringify(other)).toContain(CAMERA_PW)
  })
})

describe('the all-principals list pins every surface that carries a source stream URL', () => {
  it('names the catalog, the registry views and the runtime-state reads', () => {
    expect([...ALL_PRINCIPALS_REDACTED_METHODS.keys()].toSorted()).toEqual([
      'cameraStreams.getCameraStreams',
      'deviceState.getAllSnapshots',
      'deviceState.getCapSlice',
      'deviceState.getSnapshot',
      'streamBroker.listAllCameraStreams',
      'streamCatalog.getCatalog',
    ])
  })
})
