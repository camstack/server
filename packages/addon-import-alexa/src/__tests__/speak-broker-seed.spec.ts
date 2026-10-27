import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_FILE } from '../alexa-remote-client.js'
import type { AlexaBrokerEntry } from '../config.js'
import { alexaConnectionSchema } from '../config.js'
import { DEFAULT_DEVICE_APP_NAME, readBrokerSeed, regionOfDomain } from '../speak/broker-seed.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alexa-seed-'))
  dirs.push(dir)
  return dir
}

function entry(connection: Record<string, unknown>): AlexaBrokerEntry {
  return {
    id: 'alexa_001',
    name: 'Home',
    connection: alexaConnectionSchema.parse(connection),
  }
}

describe('the refresh token a broker shares with Echo speech', () => {
  it('prefers the session the broker keeps refreshing on disk over the stored blob', async () => {
    const dir = await dataDir()
    await fs.writeFile(
      path.join(dir, `alexa_001.${SESSION_FILE}`),
      JSON.stringify({
        cookieData: { refreshToken: 'fresh-on-disk', deviceAppName: 'Registered' },
      }),
    )
    const seed = await readBrokerSeed(
      dir,
      entry({ cookie: JSON.stringify({ refreshToken: 'stale-in-blob' }) }),
    )
    expect(seed).toEqual({ refreshToken: 'fresh-on-disk', deviceAppName: 'Registered' })
  })

  it('falls back to the stored cookie blob, then to a bare refresh token', async () => {
    const dir = await dataDir()
    expect(
      await readBrokerSeed(dir, entry({ cookie: JSON.stringify({ refreshToken: 'from-blob' }) })),
    ).toEqual({ refreshToken: 'from-blob', deviceAppName: DEFAULT_DEVICE_APP_NAME })
    expect(await readBrokerSeed(dir, entry({ refreshToken: 'bare-token' }))).toEqual({
      refreshToken: 'bare-token',
      deviceAppName: DEFAULT_DEVICE_APP_NAME,
    })
  })

  it('gives no seed for a raw cookie string or an empty broker', async () => {
    const dir = await dataDir()
    expect(await readBrokerSeed(dir, entry({ cookie: 'session-id=1; csrf=2' }))).toBeNull()
    expect(await readBrokerSeed(undefined, entry({}))).toBeNull()
  })

  it('maps the Amazon domain to a region', () => {
    expect(regionOfDomain('amazon.com')).toBe('NA')
    expect(regionOfDomain('amazon.it')).toBe('EU')
    expect(regionOfDomain('amazon.co.jp')).toBe('FE')
  })
})
