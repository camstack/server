import { existsSync, readFileSync, statSync } from 'node:fs'
import { MutationGate } from '@camstack/develop'
import { describe, expect, it } from 'vitest'
import type { McpContext } from '../mcp/context.js'
import { CRITICAL_ADDONS } from '../mcp/report-environment.js'
import {
  prefilledIssueUrl,
  reportIssue,
  URL_MAX_CHARS,
  type ReportIssueArgs,
  type ReportResult,
} from '../mcp/report-issue.js'
import { RECIPES, REPORT_KINDS } from '../mcp/report-recipes.js'
import type { ProcessResult, SupportDeps } from '../mcp/support-deps.js'
import { dryRunOf, gatedHub } from './configure-fixtures.js'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString()

const SECRET_ENV_TOKEN = 'tok-env-secret-should-never-appear'
const HOSTNAME = 'hub.mydomain.com'

const logLine = (
  message: string,
  extra: { [k: string]: unknown } = {},
): { [k: string]: unknown } => ({
  timestamp: iso(5),
  level: 'warn',
  scope: 'pipeline-analytics',
  message,
  tags: { deviceId: '7', addonId: 'pipeline-analytics' },
  ...extra,
})

const POISONED = logLine(
  'thumb failed for Front Door at 192.168.1.50 Bearer abcdefghijklmnopqrstuvwxyz0123 via https://hub.mydomain.com/addon/x/42?token=zzzzzzzz1 mail jane@example.com',
)

const hardware = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) Ultra 7 265K',
  cpuCores: 20,
  totalRAM_MB: 64000,
  availableRAM_MB: 30000,
  gpu: null,
  npu: null,
}

function answers(extra: { [path: string]: unknown } = {}): { [path: string]: unknown } {
  return {
    'nodes.topology': [
      {
        id: HOSTNAME,
        name: 'Home Hub',
        isHub: true,
        isOnline: true,
        platform: 'linux',
        addons: [],
      },
    ],
    'serverManagement.getServerPackageStatus': { runningVersion: '1.2.523' },
    'alerts.list': [],
    'addons.listUpdates': [],
    'platformProbe.getHardware': hardware,
    'nodes.getNodeAddons': [
      {
        id: 'cloudflare-tunnel',
        status: 'running',
        version: '1.0.7',
        config: { token: SECRET_ENV_TOKEN, host: HOSTNAME },
      },
      { id: 'stream-broker', status: 'failed', version: '2.1.0' },
      { id: 'some-private-addon', status: 'running', version: '9.9.9' },
    ],
    'addonSettings.getGlobalSettings': {
      sections: [
        {
          fields: [
            { type: 'password', value: SECRET_ENV_TOKEN },
            { type: 'text', value: HOSTNAME },
          ],
        },
      ],
    },
    'deviceManager.listAll': [{ id: 7, name: 'Front Door', type: 'camera' }],
    'logs.query': { entries: [POISONED], done: true, source: 'ring' },
    'logs.sources': [],
    ...extra,
  }
}

interface GhCall {
  readonly args: readonly string[]
  bodyMode?: number
  body?: string
}

function fakeGh(authCode = 0, createCode = 0) {
  const calls: GhCall[] = []
  const deps: SupportDeps = {
    sleep: async () => undefined,
    recycleMs: 0,
    runner: async (command, args): Promise<ProcessResult> => {
      const call: GhCall = { args }
      calls.push(call)
      expect(command).toBe('gh')
      if (args[0] === 'auth')
        return { code: authCode, stdout: '', stderr: authCode === 0 ? '' : 'not logged in' }
      const at = args.indexOf('--body-file')
      const file = at >= 0 ? args[at + 1] : undefined
      if (file !== undefined && existsSync(file)) {
        call.bodyMode = statSync(file).mode & 0o777
        call.body = readFileSync(file, 'utf8')
      }
      return createCode === 0
        ? { code: 0, stdout: 'https://github.com/camstack/server/issues/901\n', stderr: '' }
        : { code: createCode, stdout: '', stderr: 'boom' }
    },
  }
  return { calls, deps }
}

const ARGS: ReportIssueArgs = {
  kind: 'media-thumbnails',
  title: 'Thumbnails empty for Front Door on 192.168.1.50',
  description: 'The grid shows no picture. My hub is hub.mydomain.com and password=hunter2hunter2.',
  deviceId: 7,
}

function ctxOf(extra: { [k: string]: unknown } = {}): {
  ctx: McpContext
  calls: ReturnType<typeof gatedHub>['calls']
} {
  const hub = gatedHub(answers(extra))
  return { ctx: hub.ctx, calls: hub.calls }
}

function dry(result: unknown): {
  token: string
  markdown: string
  describe: Record<string, unknown>
} {
  const view = dryRunOf(result)
  const describe = view.describe
  if (typeof describe !== 'object' || describe === null || view.token === undefined) {
    throw new Error('not a dry run')
  }
  const md = 'markdown' in describe ? describe.markdown : undefined
  if (typeof md !== 'string') throw new Error('no markdown')
  return { token: view.token, markdown: md, describe: Object.fromEntries(Object.entries(describe)) }
}

const ok = (r: ReportResult | { status: string }): void => {
  expect(r.status).toBe('dry-run')
}

describe('report_issue: the draft', () => {
  it('scrubs every string and reports the counts', async () => {
    const { ctx } = ctxOf()
    const gh = fakeGh()
    const result = await reportIssue(ctx, gh.deps, ARGS, undefined, NOW)
    ok(result)
    const d = dry(result)
    for (const leaked of [
      '192.168.1.50',
      'abcdefghijklmnopqrstuvwxyz0123',
      'zzzzzzzz1',
      'hunter2hunter2',
      'jane@example.com',
      'mydomain',
      'Front Door',
      SECRET_ENV_TOKEN,
      'Home Hub',
    ]) {
      expect(d.markdown, leaked).not.toContain(leaked)
    }
    expect(d.markdown).toContain('device#7')
    expect(d.markdown).toMatch(/redacted: .*IPs/)
    expect(d.describe['redacted']).toMatch(/tokens/)
    expect(gh.calls).toEqual([])
  })

  it('builds the environment from allow-listed fields only', async () => {
    const { ctx } = ctxOf()
    const d = dry(await reportIssue(ctx, fakeGh().deps, ARGS, undefined, NOW))
    expect(d.markdown).toContain('node#1 (hub): server 1.2.523, linux/x64')
    expect(d.markdown).toContain(
      '| cloudflare-tunnel | cloudflare tunnel | node#1 | 1.0.7 | running | running |',
    )
    expect(d.markdown).toContain(
      '| stream-broker | stream broker | node#1 | 2.1.0 | enabled | failed |',
    )
    expect(d.markdown).toContain('device#7: type camera')
    expect(d.markdown).not.toContain('some-private-addon')
    expect(d.markdown).not.toContain(SECRET_ENV_TOKEN)
    expect(d.markdown).not.toContain(HOSTNAME)
  })

  it('names the critical addons found on no node', async () => {
    const { ctx } = ctxOf()
    const d = dry(await reportIssue(ctx, fakeGh().deps, ARGS, undefined, NOW))
    expect(d.markdown).toContain('Not installed on any node:')
    expect(d.markdown).toContain('static-turn')
    expect(CRITICAL_ADDONS.length).toBeGreaterThan(20)
  })
})

describe('report_issue: the recipe per kind', () => {
  it('has a recipe for every kind', () => {
    for (const kind of REPORT_KINDS) expect(RECIPES[kind].length).toBeGreaterThan(0)
  })

  it('media-thumbnails reads the events:media viewer scope and pipeline-analytics', () => {
    const r = RECIPES['media-thumbnails']
    expect(r.some((s) => s.type === 'viewer' && s.scope === 'events:media')).toBe(true)
    expect(r.some((s) => s.type === 'hub' && s.addonIds.includes('pipeline-analytics'))).toBe(true)
  })

  it('remote-access reads tunnel, turn and webrtc', () => {
    const hubs = RECIPES['remote-access'].flatMap((s) => (s.type === 'hub' ? s.addonIds : []))
    for (const id of ['cloudflare-tunnel', 'cloudflare-turn', 'static-turn', 'webrtc-native']) {
      expect(hubs).toContain(id)
    }
  })

  it('asks the hub for exactly the sources of the kind', async () => {
    const { ctx, calls } = ctxOf()
    await reportIssue(ctx, fakeGh().deps, ARGS, undefined, NOW)
    const tags = calls
      .filter((c) => c.path === 'logs.query')
      .map((c) =>
        typeof c.input === 'object' && c.input !== null && 'tags' in c.input ? c.input.tags : null,
      )
    expect(tags).toContainEqual(expect.objectContaining({ source: 'viewer' }))
    expect(tags).toContainEqual(
      expect.objectContaining({ addonId: 'pipeline-analytics', deviceId: '7' }),
    )
    expect(tags).not.toContainEqual(expect.objectContaining({ addonId: 'cloudflare-tunnel' }))
  })

  it('bounds a section', async () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      logLine(`distinct failure number ${String(i)} word${String(i)}x`),
    )
    const { ctx } = ctxOf({ 'logs.query': { entries: many, done: true, source: 'ring' } })
    const d = dry(await reportIssue(ctx, fakeGh().deps, ARGS, undefined, NOW))
    expect(d.markdown).toMatch(/… \d+ more not shown/)
  })
})

describe('report_issue: the review gate', () => {
  it('a call without a token files nothing', async () => {
    const { ctx } = ctxOf()
    const gh = fakeGh()
    const r = await reportIssue(ctx, gh.deps, ARGS, undefined, NOW)
    ok(r)
    expect(gh.calls).toEqual([])
  })

  it('refuses an unknown token', async () => {
    const { ctx } = ctxOf()
    const gh = fakeGh()
    const r = await reportIssue(ctx, gh.deps, ARGS, 'cfm_nope', NOW)
    expect(r.status).toBe('refused')
    expect(gh.calls).toEqual([])
  })

  it('refuses a token presented with different text', async () => {
    const { ctx } = ctxOf()
    const gh = fakeGh()
    const d = dry(await reportIssue(ctx, gh.deps, ARGS, undefined, NOW))
    const edited = { ...ARGS, description: `${ARGS.description} (edited)` }
    const r = await reportIssue(ctx, gh.deps, edited, d.token, NOW)
    expect(r.status).toBe('refused')
    expect(gh.calls).toEqual([])
    // the burnt token does not work for the original text either
    expect((await reportIssue(ctx, gh.deps, ARGS, d.token, NOW)).status).toBe('refused')
  })

  it('files with gh -R camstack/server, a 0600 body file, and the text that was shown', async () => {
    const { ctx } = ctxOf()
    const gh = fakeGh()
    const d = dry(await reportIssue(ctx, gh.deps, ARGS, undefined, NOW))
    const r = await reportIssue(ctx, gh.deps, ARGS, d.token, NOW)
    expect(r).toMatchObject({
      status: 'executed',
      result: {
        outcome: 'created',
        url: 'https://github.com/camstack/server/issues/901',
        repo: 'camstack/server',
      },
    })
    const create = gh.calls.find((c) => c.args[0] === 'issue')
    expect(create?.args.slice(0, 3)).toEqual(['issue', 'create', '-R'])
    expect(create?.args[3]).toBe('camstack/server')
    expect(create?.bodyMode).toBe(0o600)
    expect(d.markdown.endsWith(create?.body ?? '#')).toBe(true)
    // single use
    expect((await reportIssue(ctx, gh.deps, ARGS, d.token, NOW)).status).toBe('refused')
  })

  it('files the text of the draft the token belongs to, not a newer one', async () => {
    let n = 0
    const { ctx } = ctxOf({
      'logs.query': () => ({
        entries: [logLine(`draft marker ${String((n += 1))}`)],
        done: true,
        source: 'ring',
      }),
    })
    const gh = fakeGh()
    const first = dry(await reportIssue(ctx, gh.deps, ARGS, undefined, NOW))
    const second = dry(await reportIssue(ctx, gh.deps, ARGS, undefined, NOW))
    expect(first.markdown).not.toBe(second.markdown)
    await reportIssue(ctx, gh.deps, ARGS, first.token, NOW)
    const body = gh.calls.find((c) => c.args[0] === 'issue')?.body ?? ''
    expect(first.markdown.endsWith(body)).toBe(true)
    expect(second.markdown.endsWith(body)).toBe(false)
  })

  it('is refused when mutations are disabled', async () => {
    const { ctx } = ctxOf()
    const off: McpContext = { ...ctx, gate: new MutationGate({ allowMutations: false }) }
    expect((await reportIssue(off, fakeGh().deps, ARGS, undefined, NOW)).status).toBe('refused')
  })
})

describe('report_issue: without gh', () => {
  it('falls back to a prefilled link when gh is not signed in', async () => {
    const { ctx } = ctxOf()
    const gh = fakeGh(1)
    const d = dry(await reportIssue(ctx, gh.deps, ARGS, undefined, NOW))
    const r = await reportIssue(ctx, gh.deps, ARGS, d.token, NOW)
    expect(r).toMatchObject({ status: 'executed', result: { outcome: 'link', truncated: false } })
    const url = r.status === 'executed' && r.result.outcome === 'link' ? r.result.url : ''
    expect(url.startsWith('https://github.com/camstack/server/issues/new?title=')).toBe(true)
    expect(gh.calls.some((c) => c.args[0] === 'issue')).toBe(false)
  })

  it('falls back when gh fails to create', async () => {
    const { ctx } = ctxOf()
    const gh = fakeGh(0, 1)
    const d = dry(await reportIssue(ctx, gh.deps, ARGS, undefined, NOW))
    const r = await reportIssue(ctx, gh.deps, ARGS, d.token, NOW)
    expect(r).toMatchObject({ status: 'executed', result: { outcome: 'link' } })
  })

  it('cuts a long body to a safe link length, on whole escapes, and says so', () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${String(i)} é ✓ & more`).join('\n')
    const { url, truncated } = prefilledIssueUrl({ repo: 'camstack/server', title: 'T', body })
    expect(truncated).toBe(true)
    expect(url.length).toBeLessThanOrEqual(URL_MAX_CHARS)
    const decoded = decodeURIComponent(url.split('&body=')[1] ?? '')
    expect(decoded).toContain('cut to fit a link')
  })
})
