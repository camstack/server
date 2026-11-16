/**
 * `ops_logs_export` (#570) on the public MCP: the same route and defaults as the
 * Logs page, the file written under the export dir, a bounded summary, admin only.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HubDownloader } from '@camstack/develop'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpContext } from '../mcp/context.js'
import { opsLogsExport } from '../mcp/ops-logs-export.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const NOW = new Date('2026-11-15T12:00:00.000Z')
const BODY = [
  {
    timestamp: '2026-11-15T11:59:00.000Z',
    level: 'warn',
    tags: { addonId: 'cam-a', deviceId: '7' },
  },
  {
    timestamp: '2026-11-15T11:30:00.000Z',
    level: 'info',
    tags: { addonId: 'cam-a', deviceId: '7' },
  },
  {
    timestamp: '2026-11-15T10:00:00.000Z',
    level: 'info',
    tags: { addonId: 'cam-b', deviceId: '8' },
  },
  { truncated: true, maxEntries: 3, lines: 3 },
]
  .map((o) => JSON.stringify(o))
  .join('\n')

describe('opsLogsExport', () => {
  let dir = ''
  const urls: string[] = []
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-logs-export-'))
    urls.length = 0
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function withDownloader(base: McpContext): McpContext {
    const downloader = (): HubDownloader => async (urlPath, destFile) => {
      urls.push(urlPath)
      fs.writeFileSync(destFile, `${BODY}\n`)
      return { bytes: BODY.length + 1 }
    }
    return { ...base, downloader, exportDir: dir }
  }

  it('downloads through the Logs route, keeps the default window and summarises the file', async () => {
    const ctx = withDownloader(fakeHub({}).ctx)
    const out = await opsLogsExport(
      ctx,
      { components: ['cam-a'], deviceIds: [7], level: 'warn' },
      () => NOW,
    )
    expect(out).toMatchObject({ status: 'ok', lines: 3, truncated: true })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(urls).toEqual(['/api/logs/export?components=cam-a&deviceIds=7&level=warn'])
    expect(out.devices).toEqual({ '7': 2, '8': 1 })
    expect(out.components).toEqual({ 'cam-a': 2, 'cam-b': 1 })
    expect(out.newest).toBe('2026-11-15T11:59:00.000Z')
    expect(out.path.startsWith(path.join(dir, 'logs'))).toBe(true)
    expect(fs.existsSync(out.path)).toBe(true)
    expect(JSON.stringify(out)).not.toContain('tok-should-never-appear')
  })

  it('refuses a non-admin credential without downloading', async () => {
    const ctx = withDownloader(fakeHub({}, 'protected').ctx)
    const out = await opsLogsExport(ctx, {}, () => NOW)
    expect(out).toMatchObject({ status: 'refused' })
    expect(urls).toEqual([])
  })

  it('reports a failed download as a refusal with the reason', async () => {
    const ctx: McpContext = {
      ...fakeHub({}).ctx,
      exportDir: dir,
      downloader: () => async () => {
        throw new Error('hub answered HTTP 500 for the export download')
      },
    }
    const out = await opsLogsExport(ctx, {}, () => NOW)
    expect(out).toMatchObject({ status: 'refused' })
    expect(JSON.stringify(out)).toContain('HTTP 500')
  })

  it('answers no-session without a login', async () => {
    expect(await opsLogsExport(noSessionContext(), {})).toMatchObject({ status: 'no-session' })
  })
})
