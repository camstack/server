import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/**
 * A dead general session (the BCUDP session the camera ends every ~30 min) is
 * recycled by the library only when the consumer allows it on a camera that
 * may be battery-powered. A powered camera and a hub always allow it; a battery
 * camera keeps the library's own check, so a recycle never wakes it.
 */

const recyclingCalls: unknown[] = []

vi.mock('@apocaliss92/nodelink-js', () => ({
  ReolinkBaichuanApi: class {
    setGeneralSessionRecycling(opts: unknown): void {
      recyclingCalls.push(opts)
    }
    async login(): Promise<void> {}
  },
}))

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

describe('general-session recycling', () => {
  it('a hub always allows the recycle', async () => {
    const { connectReolinkHub } = await import('../reolink-hub-session.js')
    await connectReolinkHub({
      host: '192.0.2.1',
      port: 9000,
      rtspPort: 554,
      username: 'u',
      password: 'p',
      transport: 'tcp',
      debugGeneral: false,
      debugSocketLogs: [],
    })
    expect(recyclingCalls).toHaveLength(1)
    const opts = recyclingCalls[0]
    if (typeof opts !== 'object' || opts === null || !('guard' in opts)) {
      throw new Error('no guard passed')
    }
    const guard = opts.guard
    expect(typeof guard === 'function' ? guard() : null).toBe(true)
  })

  it('a camera allows it only once the login decided it is not battery-powered', () => {
    const decided = cameraSource.indexOf('Reolink camera flagged as battery (live probe)')
    const allow = cameraSource.indexOf(
      'if (!this.isBattery) api.setGeneralSessionRecycling({ guard: () => true })',
    )
    expect(decided).toBeGreaterThan(-1)
    expect(allow).toBeGreaterThan(decided)
    expect(cameraSource.match(/setGeneralSessionRecycling/g)).toHaveLength(1)
  })
})
