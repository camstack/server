/**
 * A paired agent that lost its hub address finds ITS hub again over mDNS, by the hub id it
 * recorded at pairing - never another hub on the same LAN (#494).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MdnsHub } from '@camstack/develop/hub-discovery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHubRediscoveryNotice,
  rediscoverPairedHub,
  startHubRediscoveryWatch,
} from '../agent-hub-rediscovery.js'

const MINE = 'hub-0123456789abcdef'
const OTHER = 'hub-fedcba9876543210'
const MESH = { certPem: 'cert', keyPem: 'key', caCertPem: 'ca' }

let dir: string
let configPath: string
const logs: string[] = []
const log = {
  info: (m: string) => void logs.push(`info ${m}`),
  warn: (m: string) => void logs.push(`warn ${m}`),
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rediscovery-'))
  configPath = path.join(dir, 'agent.json')
  logs.length = 0
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeConfig(value: Record<string, unknown>): void {
  fs.writeFileSync(configPath, JSON.stringify(value))
}
const read = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  return parsed !== null && typeof parsed === 'object'
    ? Object.fromEntries(Object.entries(parsed))
    : {}
}
const browseOf = (hubs: readonly MdnsHub[]) => async (): Promise<readonly MdnsHub[]> => hubs
const acceptHub = async (): Promise<boolean> => true

describe('rediscoverPairedHub', () => {
  it('finds the hub with the recorded id, persists its address, ignores the other hub', async () => {
    writeConfig({ nodeId: 'agent-a', meshTls: MESH, hubAddress: null, hubId: MINE })
    const outcome = await rediscoverPairedHub({
      configPath,
      log,
      browse: browseOf([
        { url: 'https://192.0.2.50:4443', nodeId: 'hub', hubId: OTHER, version: '1' },
        { url: 'https://192.0.2.9:4443', nodeId: 'hub', hubId: MINE, version: '1' },
      ]),
      authenticate: acceptHub,
    })
    expect(outcome).toEqual({
      kind: 'found',
      hubAddress: '192.0.2.9',
      hubUrl: 'https://192.0.2.9:4443',
    })
    expect(read()['hubAddress']).toBe('192.0.2.9')
    expect(read()['hubUrl']).toBe('https://192.0.2.9:4443')
    // The pairing material is untouched.
    expect(read()['meshTls']).toEqual(MESH)
  })

  it('never adopts a hub announcing another id, or none', async () => {
    writeConfig({ nodeId: 'agent-a', meshTls: MESH, hubId: MINE })
    const outcome = await rediscoverPairedHub({
      configPath,
      log,
      browse: browseOf([
        { url: 'https://192.0.2.50:4443', nodeId: 'hub', hubId: OTHER, version: '1' },
        { url: 'https://192.0.2.51:4443', nodeId: 'hub', version: '1' },
      ]),
    })
    expect(outcome).toEqual({ kind: 'not-found', announced: 2 })
    expect(read()['hubAddress']).toBeUndefined()
    expect(logs.some((l) => l.startsWith('warn') && l.includes(MINE))).toBe(true)
  })

  it('does nothing for an agent that has an address, or is not paired', async () => {
    let browsed = 0
    const browse = async (): Promise<readonly MdnsHub[]> => {
      browsed += 1
      return []
    }
    writeConfig({ meshTls: MESH, hubAddress: '192.0.2.9', hubId: MINE })
    expect(await rediscoverPairedHub({ configPath, log, browse })).toEqual({ kind: 'not-needed' })
    writeConfig({ hubId: MINE })
    expect(await rediscoverPairedHub({ configPath, log, browse })).toEqual({ kind: 'not-needed' })
    expect(browsed).toBe(0)
  })

  it('a pairing that recorded no hub id cannot be found again: it says so', async () => {
    writeConfig({ meshTls: MESH, hubAddress: null })
    const outcome = await rediscoverPairedHub({ configPath, log, browse: browseOf([]) })
    expect(outcome).toEqual({ kind: 'no-hub-id' })
    expect(logs.some((l) => l.startsWith('warn'))).toBe(true)
  })

  it('warns once that there is no hub id, and again only after that situation changes', async () => {
    const notice = createHubRediscoveryNotice()
    writeConfig({ meshTls: MESH, hubAddress: null })
    await rediscoverPairedHub({ configPath, log, browse: browseOf([]), notice })
    await rediscoverPairedHub({ configPath, log, browse: browseOf([]), notice })
    const noHubId = (): number => logs.filter((l) => l.includes('no hub id')).length
    expect(noHubId()).toBe(1)
    writeConfig({ meshTls: MESH, hubId: MINE })
    await rediscoverPairedHub({
      configPath,
      log,
      browse: browseOf([]),
      notice,
      authenticate: async () => false,
    })
    writeConfig({ meshTls: MESH })
    await rediscoverPairedHub({ configPath, log, browse: browseOf([]), notice })
    expect(noHubId()).toBe(2)
  })

  it('never persists a candidate with the right hub id that fails the pinned-CA check; the genuine one after it is saved', async () => {
    writeConfig({ nodeId: 'agent-a', meshTls: MESH, hubId: MINE })
    const asked: string[] = []
    const outcome = await rediscoverPairedHub({
      configPath,
      log,
      browse: browseOf([
        { url: 'https://192.0.2.50:4443', nodeId: 'hub', hubId: MINE, version: '1' },
        { url: 'https://192.0.2.9:4443', nodeId: 'hub', hubId: MINE, version: '1' },
      ]),
      authenticate: async (candidate) => {
        asked.push(candidate.hubUrl)
        return candidate.hubUrl === 'https://192.0.2.9:4443'
      },
    })
    expect(asked).toEqual(['https://192.0.2.50:4443', 'https://192.0.2.9:4443'])
    expect(outcome).toEqual({
      kind: 'found',
      hubAddress: '192.0.2.9',
      hubUrl: 'https://192.0.2.9:4443',
    })
    expect(read()['hubAddress']).toBe('192.0.2.9')
    expect(read()['hubUrl']).toBe('https://192.0.2.9:4443')
  })

  it('refuses an announcement it cannot dial (loopback)', async () => {
    writeConfig({ meshTls: MESH, hubId: MINE })
    const outcome = await rediscoverPairedHub({
      configPath,
      log,
      browse: browseOf([
        { url: 'https://127.0.0.1:4443', nodeId: 'hub', hubId: MINE, version: '1' },
      ]),
    })
    expect(outcome.kind).toBe('not-found')
    expect(read()['hubAddress']).toBeUndefined()
  })
})

describe('startHubRediscoveryWatch', () => {
  it('keeps looking while the hub is away, and relaunches once when it appears', async () => {
    vi.useFakeTimers()
    try {
      writeConfig({ meshTls: MESH, hubId: MINE })
      let online = false
      let relaunches = 0
      const stop = startHubRediscoveryWatch({
        configPath,
        log,
        intervalMs: 1_000,
        browse: async () =>
          online
            ? [{ url: 'https://192.0.2.9:4443', nodeId: 'hub', hubId: MINE, version: '1' }]
            : [],
        authenticate: acceptHub,
        onFound: () => void (relaunches += 1),
      })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(relaunches).toBe(0)
      online = true
      await vi.advanceTimersByTimeAsync(1_000)
      expect(relaunches).toBe(1)
      expect(read()['hubAddress']).toBe('192.0.2.9')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(relaunches).toBe(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
