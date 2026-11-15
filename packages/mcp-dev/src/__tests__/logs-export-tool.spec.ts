/**
 * `hub_logs_export` (#570) — the same route, filters and default as the Logs
 * page: no `since` means the hub's six-hour default; components and devices go
 * through as the comma lists the route reads; the file lands in the workspace
 * scratchpad and the answer is a bounded summary of it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseApiIndex } from '@camstack/develop'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGatedHub, isLogsExportPath, type OpsHub } from '../ops/hub.js'
import { hubLogsExport, logsExportUrl } from '../ops/logs-export.js'

const NOW = new Date('2026-11-15T12:00:00.000Z')

const NDJSON = [
  {
    id: '1',
    timestamp: '2026-11-15T11:59:00.000Z',
    level: 'warn',
    message: 'a',
    tags: { addonId: 'cam-a', deviceId: '7' },
  },
  {
    id: '2',
    timestamp: '2026-11-15T11:30:00.000Z',
    level: 'info',
    message: 'b',
    tags: { addonId: 'cam-a', deviceId: '7' },
  },
  {
    id: '3',
    timestamp: '2026-11-15T10:00:00.000Z',
    level: 'info',
    message: 'c',
    tags: { addonId: 'cam-b', deviceId: '8' },
  },
  { truncated: true, maxEntries: 3, lines: 3 },
]
  .map((o) => JSON.stringify(o))
  .join('\n')

function writingHub(body: string): OpsHub & { readonly urls: string[] } {
  const urls: string[] = []
  return {
    server: 'https://hub.example.test',
    tier: 'admin',
    source: 'session',
    adminHint: null,
    urls,
    query: async () => {
      throw new Error('no query expected')
    },
    download: async (urlPath, destFile) => {
      urls.push(urlPath)
      fs.writeFileSync(destFile, `${body}\n`)
      return { bytes: body.length + 1 }
    },
  }
}

describe('logsExportUrl', () => {
  it('sends no since without a range, so the hub applies its six-hour default', () => {
    expect(logsExportUrl({}, NOW.getTime())).toBe('/api/logs/export')
  })

  it('maps components, devices, level, provider and a minutes window', () => {
    const url = new URL(
      logsExportUrl(
        {
          components: ['cam-a', 'cam-b'],
          deviceIds: [7, 8],
          sinceMinutes: 30,
          level: 'warn',
          provider: 'ring',
        },
        NOW.getTime(),
      ),
      'http://x',
    )
    expect(url.pathname).toBe('/api/logs/export')
    expect(url.searchParams.get('components')).toBe('cam-a,cam-b')
    expect(url.searchParams.get('deviceIds')).toBe('7,8')
    expect(url.searchParams.get('since')).toBe(String(NOW.getTime() - 30 * 60_000))
    expect(url.searchParams.get('until')).toBeNull()
    expect(url.searchParams.get('level')).toBe('warn')
    expect(url.searchParams.get('source')).toBe('ring')
    expect(isLogsExportPath(`${url.pathname}${url.search}`)).toBe(true)
  })
})

describe('hub_logs_export', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-export-root-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('downloads into scratchpad/logs-export and summarises the file', async () => {
    const hub = writingHub(NDJSON)
    const r = await hubLogsExport(root, hub, { deviceIds: [7, 8], name: 'run1' }, () => NOW)
    expect(hub.urls).toEqual(['/api/logs/export?deviceIds=7%2C8'])
    expect(r).toMatchObject({
      path: path.join('scratchpad', 'logs-export', 'run1.ndjson'),
      lines: 3,
      newest: '2026-11-15T11:59:00.000Z',
      oldest: '2026-11-15T10:00:00.000Z',
      levels: { warn: 1, info: 2 },
      devices: { '7': 2, '8': 1 },
      components: { 'cam-a': 2, 'cam-b': 1 },
      truncated: true,
    })
  })

  it('the gated hub allows the export only for an admin credential', async () => {
    const make = (tier: 'admin' | 'protected') =>
      createGatedHub({
        server: 'https://hub.example.test',
        tier,
        source: 'session',
        index: parseApiIndex(''),
        client: { call: async () => null },
        downloader: async () => ({ bytes: 1 }),
      })
    await expect(make('protected').download('/api/logs/export', '/tmp/x', 10)).rejects.toThrow(
      /admin-only/,
    )
    await expect(
      make('admin').download('/api/logs/export?deviceIds=7', '/tmp/x', 10),
    ).resolves.toEqual({
      bytes: 1,
    })
    expect(isLogsExportPath('/api/logs/export/../../trpc/x')).toBe(false)
    expect(isLogsExportPath('https://evil.test/api/logs/export')).toBe(false)
  })
})
