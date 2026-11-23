/**
 * The broker polls a stream's source every 1–2 s and several callers ask at
 * once; each `materializeStreamSocket` used to open/log/re-publish the same
 * URL (10–15 duplicate lines at once), and every re-publish kicks the broker's
 * reconnect. Concurrent callers share ONE run per camStreamId.
 */
import { describe, expect, it, vi } from 'vitest'
import { ReolinkCamera } from '../reolink-camera.js'

const server = {
  username: 'u',
  password: 'p',
  host: '127.0.0.1',
  port: 1,
  videoType: 'H264',
  sdp: 's',
}

function makeCamera(ensure: () => Promise<unknown>) {
  const camera = Object.create(ReolinkCamera.prototype)
  const publishOne = vi.fn(async () => undefined)
  const ensureRfc4571Server = vi.fn(ensure)
  Object.defineProperties(camera, {
    id: { value: 3628 },
    materializeInFlight: { value: new Map() },
    ctx: { value: { logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } } },
    getChannel: { value: () => 0 },
    cachedStreamDescriptors: { value: undefined, writable: true },
    ensureRfc4571Server: { value: ensureRfc4571Server },
    publishOne: { value: publishOne },
  })
  return { camera, publishOne, ensureRfc4571Server }
}

describe('ReolinkCamera.materializeStreamSocket', () => {
  it('concurrent callers for one stream share a single run', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { camera, publishOne, ensureRfc4571Server } = makeCamera(async () => {
      await gate
      return server
    })
    const calls = [1, 2, 3, 4].map(() => camera.materializeStreamSocket('native:main'))
    release()
    await Promise.all(calls)
    expect(publishOne).toHaveBeenCalledTimes(1)
    expect(ensureRfc4571Server).toHaveBeenCalledTimes(1)
  })

  it('a later call after the run settled starts a fresh one', async () => {
    const { camera, publishOne } = makeCamera(async () => server)
    await camera.materializeStreamSocket('native:main')
    await camera.materializeStreamSocket('native:main')
    expect(publishOne).toHaveBeenCalledTimes(2)
  })
})
