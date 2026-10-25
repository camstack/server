/**
 * `camstack login` / `discover` hub finding (D838): mDNS announcements UNION
 * the hubs this machine knows, deduped by host:port, unreachable dropped, and
 * a picker only when there is a choice.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findHubs, knownHubCandidates, validateManualHubUrl } from '../discovery/hub-finder.js'
import {
  MANUAL_ENTRY_LABEL,
  MANUAL_ENTRY_VALUE,
  NO_HUB_MESSAGE,
  type HubPrompts,
  pickHub,
} from '../discovery/hub-picker.js'
import type { MdnsHub } from '@camstack/develop/hub-discovery'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-hubfinder-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeSession(server: string, username: string): void {
  const slug = server.replace(/^https?:\/\//, '').replace(/[:/]+/g, '_')
  fs.writeFileSync(
    path.join(dir, `${slug}.json`),
    JSON.stringify({
      server,
      username,
      tokenId: 't',
      token: 'tok_x',
      scopes: [],
      createdAt: 1,
    }),
  )
}

const mdnsHub = (url: string, nodeId = 'hub', version = '1.2.3'): MdnsHub => ({
  url,
  nodeId,
  version,
})

const reachable =
  (...ok: string[]) =>
  async (host: string, port: number) =>
    ok.includes(`${host}:${port}`)

describe('findHubs', () => {
  it('unions mDNS with every known source and dedupes by host:port, keeping all sources', async () => {
    writeSession('https://192.0.2.10:4443', 'admin')
    // a stale token file names no hub: only sessions do
    fs.writeFileSync(path.join(dir, '192.168.1.40_4443.admin-token'), 'opaque_x')
    const hubs = await findHubs({
      sessionDir: dir,
      env: { CAMSTACK_HUB_URL: 'https://192.0.2.20:4443' },
      browse: async () => [mdnsHub('https://192.0.2.10:4443')],
      probe: reachable('192.0.2.10:4443', '192.168.1.40:4443', '192.0.2.20:4443'),
    })
    const byUrl = new Map(hubs.map((h) => [h.url, h]))
    expect(hubs).toHaveLength(2)
    expect(byUrl.get('https://192.0.2.10:4443')?.sources).toEqual([
      'LAN (mDNS)',
      'saved session admin',
    ])
    expect(byUrl.get('https://192.0.2.10:4443')?.nodeId).toBe('hub')
    expect(byUrl.get('https://192.168.1.40:4443')).toBeUndefined()
    expect(byUrl.get('https://192.0.2.20:4443')?.sources).toEqual(['CAMSTACK_HUB_URL'])
  })

  it('drops candidates that do not answer on https', async () => {
    writeSession('https://192.168.1.77:4443', 'old')
    const hubs = await findHubs({
      sessionDir: dir,
      env: {},
      browse: async () => [mdnsHub('https://192.0.2.10:4443')],
      probe: reachable('192.0.2.10:4443'),
    })
    expect(hubs.map((h) => h.url)).toEqual(['https://192.0.2.10:4443'])
  })

  it('reads scratchpad/.hub-url when a workspace root is given', async () => {
    fs.mkdirSync(path.join(dir, 'scratchpad'))
    fs.writeFileSync(path.join(dir, 'scratchpad', '.hub-url'), 'https://192.0.2.10:4443\n')
    const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-empty-'))
    try {
      const hubs = await findHubs({
        sessionDir: sessions,
        env: {},
        workspaceRoot: dir,
        browse: async () => [],
        probe: reachable('192.0.2.10:4443'),
      })
      expect(hubs.map((h) => h.sources)).toEqual([['scratchpad/.hub-url']])
    } finally {
      fs.rmSync(sessions, { recursive: true, force: true })
    }
  })

  it('finds nothing without throwing when there is no multicast and nothing is known', async () => {
    const hubs = await findHubs({
      sessionDir: path.join(dir, 'missing'),
      env: {},
      browse: async () => [],
      probe: reachable(),
    })
    expect(hubs).toEqual([])
  })
})

describe('known hub sources', () => {
  it('ignores a torn session file', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json')
    expect(knownHubCandidates({ sessionDir: dir, env: {} })).toEqual([])
  })
})

describe('pickHub', () => {
  const hub = (url: string, sources: string[]) => ({
    url,
    host: new URL(url).hostname,
    port: Number(new URL(url).port),
    nodeId: null,
    version: null,
    sources,
  })
  const refusing: HubPrompts = {
    select: async () => {
      throw new Error('must not prompt')
    },
    text: async () => {
      throw new Error('must not prompt')
    },
  }

  it('fails with a message naming --server when nothing was found', async () => {
    await expect(pickHub([], refusing)).rejects.toThrow(NO_HUB_MESSAGE)
    expect(NO_HUB_MESSAGE).toContain('--server')
  })

  it('a single found hub is the default choice next to the manual entry, one keypress', async () => {
    let shown: readonly { value: string; label: string }[] = []
    const choice = await pickHub([hub('https://192.0.2.10:4443', ['LAN (mDNS)'])], {
      select: async (_m, options) => {
        shown = options
        return options[0]!.value // Enter on the default
      },
      text: refusing.text,
    })
    expect(choice).toBe('https://192.0.2.10:4443')
    expect(shown.map((o) => o.value)).toEqual(['https://192.0.2.10:4443', MANUAL_ENTRY_VALUE])
    expect(shown.at(-1)).toEqual({ value: MANUAL_ENTRY_VALUE, label: MANUAL_ENTRY_LABEL })
  })

  it('a single found hub still lets the operator type another (a hub that does not announce)', async () => {
    const choice = await pickHub([hub('https://192.0.2.10:4443', ['LAN (mDNS)'])], {
      select: async () => MANUAL_ENTRY_VALUE,
      text: async () => '192.0.2.20',
    })
    expect(choice).toBe('https://192.0.2.20:4443')
  })

  it('shows several hubs with their sources plus a manual entry', async () => {
    let shown: readonly { value: string; label: string }[] = []
    const choice = await pickHub(
      [
        hub('https://192.0.2.10:4443', ['LAN (mDNS)', 'saved session admin']),
        hub('https://192.0.2.20:4443', ['CAMSTACK_HUB_URL']),
      ],
      {
        select: async (_m, options) => {
          shown = options
          return 'https://192.0.2.20:4443'
        },
        text: refusing.text,
      },
    )
    expect(choice).toBe('https://192.0.2.20:4443')
    expect(shown[0]?.label).toContain('LAN (mDNS), saved session admin')
    expect(shown[1]?.label).toContain('CAMSTACK_HUB_URL')
    expect(shown.at(-1)).toEqual({ value: MANUAL_ENTRY_VALUE, label: MANUAL_ENTRY_LABEL })
  })

  it('asks for an address on manual entry and validates it as an https URL', async () => {
    const captured: { validate: (v: string) => string | undefined } = { validate: () => 'unset' }
    const choice = await pickHub([hub('https://a:4443', ['x']), hub('https://b:4443', ['y'])], {
      select: async () => MANUAL_ENTRY_VALUE,
      text: async (_m, validate) => {
        captured.validate = validate
        return ' https://192.168.1.60:4443/ '
      },
    })
    expect(choice).toBe('https://192.168.1.60:4443')
    expect(captured.validate('192.168.1.60')).toBeUndefined()
    expect(captured.validate('http://192.168.1.60')).toMatch(/https/)
    expect(captured.validate('https://')).toBeDefined()
    expect(captured.validate('https://192.168.1.60:4443')).toBeUndefined()
    expect(validateManualHubUrl('https://hub.lan')).toBeUndefined()
  })
})
