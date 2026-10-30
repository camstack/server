import { readFileSync, existsSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { McpContext } from '../mcp/context.js'
import type { ProcessResult, SupportDeps } from '../mcp/support-deps.js'
import {
  githubRepoOf,
  resolveRepo,
  supportDraftIssue,
  supportDraftPr,
  type DraftArgs,
} from '../mcp/support-draft.js'
import { maskAddresses, scrubForPublic } from '../mcp/support-scrub.js'
import { dryRunOf, gatedHub } from './configure-fixtures.js'

const TOKEN_IN_FAKE_HUB = 'tok-should-never-appear-in-output'

const ultra = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) Ultra 7 265K',
  cpuCores: 20,
  totalRAM_MB: 64000,
  availableRAM_MB: 30000,
  gpu: { type: 'intel', name: 'Arc' },
  npu: { type: 'intel-npu' },
}

const hubAnswers = {
  'serverManagement.getServerPackageStatus': { runningVersion: '1.4.2' },
  'platformProbe.getHardware': ultra,
  'pipelineOrchestrator.getNodeInferenceDevices': {
    reachable: true,
    devices: [
      {
        key: 'cpu',
        backend: 'cpu',
        device: 'cpu',
        available: true,
        enabled: true,
        exclusion: null,
      },
    ],
  },
}

function ctxWithRegistry(
  registry: (url: string) => Response,
  answers: { readonly [path: string]: unknown } = hubAnswers,
): { readonly ctx: McpContext; readonly urls: string[] } {
  const hub = gatedHub(answers)
  const urls: string[] = []
  return {
    urls,
    ctx: {
      ...hub.ctx,
      fetch: async (url) => {
        urls.push(url)
        return registry(url)
      },
    },
  }
}

const registryRepo =
  (url: string): ((u: string) => Response) =>
  () =>
    new Response(JSON.stringify({ repository: { type: 'git', url } }))

interface GhCall {
  readonly command: string
  readonly args: readonly string[]
  bodyMode?: number
  body?: string
}

function fakeGh(
  authCode = 0,
  createResult: ProcessResult = {
    code: 0,
    stdout: 'https://github.com/camstack/addon-x/issues/12\n',
    stderr: '',
  },
) {
  const calls: GhCall[] = []
  const deps: SupportDeps = {
    sleep: async () => undefined,
    recycleMs: 0,
    runner: async (command, args) => {
      const call: GhCall = { command, args }
      calls.push(call)
      if (args[0] === 'auth') {
        return {
          code: authCode,
          stdout: '',
          stderr: authCode === 0 ? '' : 'You are not logged into any GitHub hosts',
        }
      }
      const at = args.indexOf('--body-file')
      const file = at >= 0 ? args[at + 1] : undefined
      if (file !== undefined) {
        call.bodyMode = statSync(file).mode & 0o777
        call.body = readFileSync(file, 'utf8')
      }
      return createResult
    },
  }
  return { calls, deps }
}

const ISSUE: DraftArgs = {
  kind: 'accelerator',
  title: 'NPU not offered on 192.168.1.50',
  summary:
    'The NPU is missing. My hub is at 192.168.1.50 and the public one at 8.8.8.8. password: hunter2secretvalue and /Users/jane/.camstack/session.json',
  nodeId: 'hub',
  expected: 'intel-npu',
}

describe('the target repository', () => {
  it('reads the repository field of the addon package from npm', async () => {
    const { ctx, urls } = ctxWithRegistry(
      registryRepo('git+https://github.com/camstack/addon-x.git'),
    )
    const target = await resolveRepo(ctx, '@camstack/addon-provider-reolink')
    expect(target).toMatchObject({
      repo: 'camstack/addon-x',
      source: 'package-repository-field',
    })
    expect(urls).toEqual(['https://registry.npmjs.org/@camstack%2Faddon-provider-reolink/latest'])
  })

  it('understands the string and shorthand spellings', () => {
    expect(githubRepoOf('github:owner/repo')).toBe('owner/repo')
    expect(githubRepoOf('git@github.com:owner/repo.git')).toBe('owner/repo')
    expect(githubRepoOf('https://github.com/owner/repo/tree/main/packages/x')).toBe('owner/repo')
    expect(githubRepoOf('https://gitlab.com/owner/repo')).toBeNull()
  })

  it('falls back to camstack/server and says why', async () => {
    const none = ctxWithRegistry(() => new Response(JSON.stringify({})))
    expect(await resolveRepo(none.ctx, '@camstack/addon-x')).toMatchObject({
      repo: 'camstack/server',
      source: 'fallback',
      reason: expect.stringContaining('no GitHub repository'),
    })
    const missing = ctxWithRegistry(() => new Response('{}', { status: 404 }))
    expect(await resolveRepo(missing.ctx, '@camstack/addon-x')).toMatchObject({
      source: 'fallback',
    })
    const other = ctxWithRegistry(registryRepo('https://gitlab.com/o/r'))
    expect(await resolveRepo(other.ctx, '@camstack/addon-x')).toMatchObject({
      source: 'fallback',
    })
    expect(await resolveRepo(none.ctx, undefined)).toMatchObject({
      repo: 'camstack/server',
    })
  })

  it('never asks the registry about a malformed package name', async () => {
    const { ctx, urls } = ctxWithRegistry(registryRepo('https://github.com/a/b'))
    const target = await resolveRepo(ctx, '../../etc/passwd')
    expect(target.source).toBe('fallback')
    expect(urls).toEqual([])
  })
})

describe('scrubbing for a public place', () => {
  it('masks private addresses by range, drops public ones, hides home directories', () => {
    expect(
      maskAddresses('a 192.168.1.50 b 10.1.2.3 c 172.20.0.9 d 8.8.8.8 e fe80::1ff:fe23:4567:890a'),
    ).toBe('a 192.168.x.x b 10.x.x.x c 172.20.x.x d [ip] e [ipv6]')
    expect(maskAddresses('/Users/jane/.camstack/x and /home/bob/y')).toBe(
      '/Users/~/.camstack/x and /home/~/y',
    )
    expect(maskAddresses('server 1.4.2 and 1.2.3.4.5')).toContain('1.4.2')
  })

  it('also applies the secret patterns', () => {
    expect(scrubForPublic('token=abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
  })
})

describe('support_draft_issue', () => {
  it('dry run is the full scrubbed draft and the target, and runs no gh', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('git+https://github.com/camstack/addon-x.git'))
    const gh = fakeGh()
    const dry = await supportDraftIssue(ctx, gh.deps, ISSUE, undefined)
    const view = dryRunOf(dry)
    expect(view.token).toBeDefined()
    expect(view.describe).toMatchObject({
      targetRepo: 'camstack/addon-x',
      title: 'NPU not offered on 192.168.x.x',
      command: expect.stringContaining('gh issue create --repo camstack/addon-x --title'),
    })
    const text = JSON.stringify(view.describe)
    for (const leaked of [
      '192.168.1.50',
      '8.8.8.8',
      'hunter2secretvalue',
      '/Users/jane',
      TOKEN_IN_FAKE_HUB,
    ]) {
      expect(text).not.toContain(leaked)
    }
    expect(text).toContain('camstack server: 1.4.2')
    expect(text).toContain('camstack CLI: 9.9.9')
    expect(text).toContain('Intel(R) Core(TM) Ultra 7 265K')
    expect(text).toContain('misconfigured')
    expect(gh.calls).toEqual([])
  })

  it('execute: checks gh auth, then creates with a 0600 body file that is removed after', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('git+https://github.com/camstack/addon-x.git'))
    const gh = fakeGh()
    const token = dryRunOf(await supportDraftIssue(ctx, gh.deps, ISSUE, undefined)).token
    const done = await supportDraftIssue(ctx, gh.deps, ISSUE, token)
    if (done.status !== 'executed') throw new Error(`expected executed: ${JSON.stringify(done)}`)
    expect(done.result).toEqual({
      outcome: 'created',
      url: 'https://github.com/camstack/addon-x/issues/12',
      repo: 'camstack/addon-x',
    })
    expect(gh.calls.map((c) => [c.command, ...c.args.slice(0, 2)])).toEqual([
      ['gh', 'auth', 'status'],
      ['gh', 'issue', 'create'],
    ])
    const create = gh.calls[1]
    if (!create) throw new Error('no create call')
    expect(create.args).toContain('camstack/addon-x')
    expect(create.bodyMode).toBe(0o600)
    expect(create.body).not.toContain('hunter2secretvalue')
    expect(create.body).not.toContain('8.8.8.8')
    // no secret in argv
    expect(JSON.stringify(create.args)).not.toContain(TOKEN_IN_FAKE_HUB)
    expect(JSON.stringify(create.args)).not.toContain('hunter2')
    const file = create.args[create.args.indexOf('--body-file') + 1]
    expect(file !== undefined && existsSync(file)).toBe(false)
  })

  it('gh not signed in: returns the draft and a ready command, creates nothing', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('git+https://github.com/camstack/addon-x.git'))
    const gh = fakeGh(1)
    const token = dryRunOf(await supportDraftIssue(ctx, gh.deps, ISSUE, undefined)).token
    const done = await supportDraftIssue(ctx, gh.deps, ISSUE, token)
    if (done.status !== 'executed') throw new Error('expected executed')
    expect(done.result).toMatchObject({
      outcome: 'gh-unavailable',
      repo: 'camstack/addon-x',
      command: expect.stringContaining('gh issue create --repo camstack/addon-x'),
      saveBodyAs: './camstack-issue.md',
    })
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]?.args).toEqual(['auth', 'status'])
  })

  it('a failing gh create is reported with the draft, the file still removed', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('git+https://github.com/camstack/addon-x.git'))
    const gh = fakeGh(0, {
      code: 1,
      stdout: '',
      stderr: 'HTTP 403 for token=ghp_abcdefghijklmnopqrstuv',
    })
    const token = dryRunOf(await supportDraftIssue(ctx, gh.deps, ISSUE, undefined)).token
    const done = await supportDraftIssue(ctx, gh.deps, ISSUE, token)
    if (done.status !== 'executed') throw new Error('expected executed')
    expect(done.result).toMatchObject({ outcome: 'gh-failed' })
    expect(JSON.stringify(done.result)).not.toContain('ghp_abcdefghijklmnopqrstuv')
    const file = gh.calls[1]?.args[(gh.calls[1]?.args.indexOf('--body-file') ?? 0) + 1]
    expect(file !== undefined && existsSync(file)).toBe(false)
  })

  it('works with no hub session: the draft carries the CLI version and says the hub facts are missing', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('https://github.com/camstack/server'))
    const noHub: McpContext = {
      ...ctx,
      hub: async () => ({
        ok: false,
        reason: 'no-session',
        message: 'no usable hub session',
        action: 'login',
      }),
    }
    const dry = await supportDraftIssue(
      noHub,
      fakeGh().deps,
      { kind: 'other', title: 'Something', summary: 'Details here' },
      undefined,
    )
    const text = JSON.stringify(dryRunOf(dry).describe)
    expect(text).toContain('camstack CLI: 9.9.9')
    expect(text).toContain('hub: not available')
  })

  it('a changed argument after the dry run burns the token: no gh call', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('https://github.com/camstack/server'))
    const gh = fakeGh()
    const token = dryRunOf(await supportDraftIssue(ctx, gh.deps, ISSUE, undefined)).token
    const out = await supportDraftIssue(ctx, gh.deps, { ...ISSUE, title: 'another title' }, token)
    expect(out).toMatchObject({ status: 'refused' })
    expect(gh.calls).toEqual([])
  })
})

describe('support_draft_pr', () => {
  const BENCH: DraftArgs = {
    kind: 'benchmark',
    title: 'Measured latency for intel-core-ultra/intel-npu',
    summary: 'Measured with support_benchmark_run.',
    nodeId: 'hub',
    column: 'intel-core-ultra/intel-npu',
    cells: { 'yolov9t-320': { p50Ms: 3, fps: 333 } },
  }

  it('benchmark: refuses without a column and cells (no token)', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('https://github.com/camstack/server'))
    const dry = await supportDraftPr(ctx, { ...BENCH, cells: undefined }, undefined)
    expect(dryRunOf(dry).token).toBeUndefined()
    expect(JSON.stringify(dry)).toContain('needs `column`')
  })

  it('benchmark: a plan with both locked files, a branch, the measured table and a gh pr create command', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('https://github.com/camstack/server'))
    const view = dryRunOf(await supportDraftPr(ctx, BENCH, undefined))
    expect(view.token).toBeDefined()
    expect(view.describe).toMatchObject({
      targetRepo: 'camstack/server',
      branch: 'benchmark/intel-core-ultra-intel-npu',
      files: [
        'docs/benchmarks/detector-latency.json',
        'packages/types/src/pipeline/auto-tune/detector-performance.ts',
      ],
      command: expect.stringContaining(
        'gh pr create --repo camstack/server --head <your-github-user>:benchmark/',
      ),
    })
    expect(JSON.stringify(view.describe)).toContain('| yolov9t-320 | 3 | 333 |')
    expect(JSON.stringify(view.describe)).toContain('detector-performance.spec.ts')
  })

  it('confirming returns the plan and spawns nothing: this tool pushes no code', async () => {
    const { ctx } = ctxWithRegistry(registryRepo('https://github.com/camstack/server'))
    const gh = fakeGh()
    const token = dryRunOf(await supportDraftPr(ctx, BENCH, undefined)).token
    const done = await supportDraftPr(ctx, BENCH, token)
    if (done.status !== 'executed') throw new Error('expected executed')
    expect(done.result).toMatchObject({
      branch: 'benchmark/intel-core-ultra-intel-npu',
    })
    expect(gh.calls).toEqual([])
  })
})
