/**
 * The node's launch arguments are decided by the closure (`launch-args.ts`) and
 * only EXECUTED by the Docker entrypoint. This pins both halves: the decision
 * (override > legacy env > computed / V8 default), the output format, and the
 * entrypoint's fail-open behaviour against a fake `node`.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_HEAP_CAP_MB,
  AGENT_HEAP_FLOOR_MB,
  HEAP_CEILING_SOURCE_ENV,
  type LaunchFs,
  type LaunchHost,
  computedAgentHeapMb,
  planLaunch,
  readCgroupLimitBytes,
  readHeapOverrideMb,
  renderLaunchPlan,
  runLaunchCli,
} from '../launch-args.js'

const GB = 1024 ** 3
const host = (totalGb: number, cgroupGb: number | null = null): LaunchHost => ({
  totalMemBytes: totalGb * GB,
  cgroupLimitBytes: cgroupGb === null ? null : cgroupGb * GB,
})
const base = {
  host: host(8),
  overrideMb: null,
  legacyEnv: undefined,
  allocatorEnv: false,
} as const

function fakeFs(files: Record<string, string>): LaunchFs {
  return { readFile: (f) => files[f] ?? null }
}

describe('computedAgentHeapMb', () => {
  it('is a quarter of RAM between the floor and the cap', () => {
    expect(computedAgentHeapMb(host(2))).toBe(AGENT_HEAP_FLOOR_MB)
    expect(computedAgentHeapMb(host(4))).toBe(AGENT_HEAP_FLOOR_MB)
    expect(computedAgentHeapMb(host(8))).toBe(2048)
    expect(computedAgentHeapMb(host(64))).toBe(AGENT_HEAP_CAP_MB)
  })

  it('a container limit below host RAM lowers it, never below the floor', () => {
    expect(computedAgentHeapMb(host(64, 8))).toBe(2048)
    expect(computedAgentHeapMb(host(64, 1))).toBe(AGENT_HEAP_FLOOR_MB)
  })

  it('never goes under the generous floor, whatever the host reports', () => {
    expect(computedAgentHeapMb({ totalMemBytes: 0, cgroupLimitBytes: null })).toBe(
      AGENT_HEAP_FLOOR_MB,
    )
    expect(computedAgentHeapMb({ totalMemBytes: Number.NaN, cgroupLimitBytes: null })).toBe(
      AGENT_HEAP_FLOOR_MB,
    )
  })
})

describe('planLaunch', () => {
  it('the hub gets V8 default: no args', () => {
    const plan = planLaunch({ ...base, role: 'hub' })
    expect(plan.args).toEqual([])
    expect(plan.source).toBe('v8-default')
  })

  it('the agent gets the computed ceiling', () => {
    const plan = planLaunch({ ...base, role: 'agent' })
    expect(plan.args).toEqual(['--max-old-space-size=2048'])
    expect(plan.source).toBe('computed')
  })

  it('the legacy env sets the hub ceiling', () => {
    const plan = planLaunch({ ...base, role: 'hub', legacyEnv: '3072' })
    expect(plan.args).toEqual(['--max-old-space-size=3072'])
    expect(plan.source).toBe('legacy-env')
  })

  it('a per-node override beats the legacy env and the computed value', () => {
    expect(
      planLaunch({ ...base, role: 'agent', overrideMb: 3000, legacyEnv: '2500' }),
    ).toMatchObject({
      args: ['--max-old-space-size=3000'],
      source: 'override',
    })
    expect(planLaunch({ ...base, role: 'hub', overrideMb: 4096 })).toMatchObject({
      args: ['--max-old-space-size=4096'],
      source: 'override',
    })
  })

  it('an out-of-range override is ignored, with a warning, never applied', () => {
    const plan = planLaunch({ ...base, role: 'agent', overrideMb: 10 })
    expect(plan.source).toBe('computed')
    expect(plan.warnings.join(' ')).toContain('heap override 10')
    const legacy = planLaunch({ ...base, role: 'hub', legacyEnv: 'lots' })
    expect(legacy.args).toEqual([])
    expect(legacy.warnings.join(' ')).toContain('"lots"')
  })

  it('always names the source in the env, and adds the allocator pair on request', () => {
    expect(planLaunch({ ...base, role: 'hub' }).env).toEqual({
      [HEAP_CEILING_SOURCE_ENV]: 'v8-default',
    })
    expect(planLaunch({ ...base, role: 'hub', allocatorEnv: true }).env).toEqual({
      [HEAP_CEILING_SOURCE_ENV]: 'v8-default',
      MALLOC_ARENA_MAX: '2',
      VIPS_CONCURRENCY: '1',
    })
  })
})

describe('reading the node', () => {
  it('reads heapMb from the override file; anything else is null', () => {
    const file = '/data/launch-overrides.json'
    expect(readHeapOverrideMb('/data', fakeFs({ [file]: '{"heapMb":3072}' }))).toBe(3072)
    expect(readHeapOverrideMb('/data', fakeFs({}))).toBeNull()
    expect(readHeapOverrideMb('/data', fakeFs({ [file]: '{nope' }))).toBeNull()
    expect(readHeapOverrideMb('/data', fakeFs({ [file]: '{"heapMb":"big"}' }))).toBeNull()
    expect(readHeapOverrideMb('/data', fakeFs({ [file]: '{"heapMb":null}' }))).toBeNull()
  })

  it('reads a cgroup limit, treating "max" and the v1 unlimited sentinel as none', () => {
    const v2 = '/sys/fs/cgroup/memory.max'
    expect(readCgroupLimitBytes(fakeFs({ [v2]: `${8 * GB}\n` }))).toBe(8 * GB)
    expect(readCgroupLimitBytes(fakeFs({ [v2]: 'max\n' }))).toBeNull()
    expect(
      readCgroupLimitBytes(
        fakeFs({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }),
      ),
    ).toBeNull()
    expect(readCgroupLimitBytes(fakeFs({}))).toBeNull()
  })
})

describe('runLaunchCli', () => {
  const deps = (env: Record<string, string>, files: Record<string, string> = {}) => ({
    env,
    io: fakeFs(files),
    totalMemBytes: 8 * GB,
    cgroupFiles: [] as string[],
  })

  it('prints the plan for the role, reading the override from CAMSTACK_DATA', () => {
    const out = runLaunchCli(
      ['--role', 'hub', '--allocator-env'],
      deps({ CAMSTACK_DATA: '/data' }, { '/data/launch-overrides.json': '{"heapMb":3072}' }),
    )
    expect(out.code).toBe(0)
    expect(out.stdout.split('\n')).toEqual(
      expect.arrayContaining([
        'arg --max-old-space-size=3072',
        'env MALLOC_ARENA_MAX=2',
        'env VIPS_CONCURRENCY=1',
        `env ${HEAP_CEILING_SOURCE_ENV}=override`,
        'source override',
      ]),
    )
  })

  it('honours the legacy env per role', () => {
    expect(
      runLaunchCli(['--role', 'hub'], deps({ CAMSTACK_HUB_HEAP_MB: '2048' })).stdout,
    ).toContain('arg --max-old-space-size=2048')
    expect(
      runLaunchCli(['--role', 'agent'], deps({ CAMSTACK_HUB_HEAP_MB: '2048' })).stdout,
    ).toContain('source computed')
  })

  it('refuses a missing or unknown role with no output', () => {
    expect(runLaunchCli([], deps({}))).toEqual({ stdout: '', code: 2 })
    expect(runLaunchCli(['--role', 'x'], deps({}))).toEqual({ stdout: '', code: 2 })
  })
})

// ---------------------------------------------------------------------------
// The Docker entrypoint block, run through a real sh against a fake `node`
// ---------------------------------------------------------------------------

const DOCKERFILE = readFileSync(resolve(__dirname, '../../../../Dockerfile'), 'utf8')
const BLOCK = DOCKERFILE.slice(
  DOCKERFILE.indexOf('# [launch-args-begin]'),
  DOCKERFILE.indexOf('# [launch-args-end]'),
)

interface EntrypointResult {
  readonly stdout: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Runs the block with `plan` as the fake module's stdout (and `exit` as its status). */
function runEntrypoint(options: {
  readonly plan: string
  readonly exit?: number
  readonly moduleExists?: boolean
  readonly role?: string
  readonly presetEnv?: Record<string, string>
}): EntrypointResult {
  const dir = mkdtempSync(join(tmpdir(), 'entrypoint-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  // `timeout` and `gosu` are coreutils/Debian tools; the shims keep this runnable on a dev Mac.
  writeFileSync(join(bin, 'gosu'), '#!/bin/sh\nshift\nexec "$@"\n')
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n')
  chmodSync(join(bin, 'timeout'), 0o755)
  writeFileSync(
    join(bin, 'node'),
    `#!/bin/sh\nprintf '%s' "$FAKE_PLAN"\nexit ${options.exit ?? 0}\n`,
  )
  chmodSync(join(bin, 'gosu'), 0o755)
  chmodSync(join(bin, 'node'), 0o755)
  const moduleJs = join(dir, 'launch-args.js')
  if (options.moduleExists !== false) writeFileSync(moduleJs, '')
  const script = [
    `launch_candidates="${moduleJs}"`,
    BLOCK,
    'for a in "$@"; do echo "ARG:$a"; done',
    'for n in MALLOC_ARENA_MAX VIPS_CONCURRENCY CAMSTACK_HEAP_CEILING_SOURCE LD_PRELOAD EVIL; do',
    '  echo "ENV:$n=$(printenv $n)"',
    'done',
  ].join('\n')
  const stdout = execFileSync('sh', ['-c', script, 'sh', '/opt/starter.js'], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CAMSTACK_ROLE: options.role ?? 'hub',
      FAKE_PLAN: options.plan,
      ...options.presetEnv,
    },
    encoding: 'utf8',
  })
  const lines = stdout.split('\n')
  const env: Record<string, string> = {}
  for (const l of lines) {
    const m = /^ENV:([A-Z_]+)=(.*)$/.exec(l)
    if (m?.[1] !== undefined) env[m[1]] = m[2] ?? ''
  }
  return {
    stdout,
    args: lines.filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4)),
    env,
  }
}

const GOOD_PLAN = renderLaunchPlan(planLaunch({ ...base, role: 'agent', allocatorEnv: true }))

describe('the Docker entrypoint executes what launch-args printed', () => {
  it('prepends the args before the starter, exports the env, and says which source', () => {
    const r = runEntrypoint({ plan: GOOD_PLAN, role: 'agent' })
    expect(r.args).toEqual(['--max-old-space-size=2048', '/opt/starter.js'])
    expect(r.env['MALLOC_ARENA_MAX']).toBe('2')
    expect(r.env['VIPS_CONCURRENCY']).toBe('1')
    expect(r.env['CAMSTACK_HEAP_CEILING_SOURCE']).toBe('computed')
    expect(r.stdout).toContain('[entrypoint] node launch: role=agent ceiling-source=computed')
  })

  it('keeps several args in the printed order', () => {
    const r = runEntrypoint({
      plan: 'arg --first=1\narg --second=2\nsource override\n',
    })
    expect(r.args).toEqual(['--first=1', '--second=2', '/opt/starter.js'])
  })

  it('an env value the operator already set wins over a default', () => {
    const r = runEntrypoint({ plan: GOOD_PLAN, presetEnv: { MALLOC_ARENA_MAX: '4' } })
    expect(r.env['MALLOC_ARENA_MAX']).toBe('4')
    expect(r.env['VIPS_CONCURRENCY']).toBe('1')
  })

  it('relays a warning the module printed', () => {
    const r = runEntrypoint({ plan: 'warn ignoring the heap override 10\nsource computed\n' })
    expect(r.stdout).toContain('[entrypoint] launch-args: ignoring the heap override 10')
  })

  it('never applies a flag or env it should not', () => {
    const r = runEntrypoint({
      plan:
        'arg --max-old-space-size=2048; touch /tmp/pwn\narg --ok=1\n' +
        'env LD_PRELOAD=/x.so\nenv EVIL=a b\nenv EVIL=x;y\nsource computed\n',
    })
    expect(r.args).toEqual(['--ok=1', '/opt/starter.js'])
    expect(r.env['LD_PRELOAD']).toBe('')
    expect(r.env['EVIL']).toBe('')
  })
})

describe('the Docker entrypoint fails open', () => {
  it('a missing module: no extra args, one log line', () => {
    const r = runEntrypoint({ plan: GOOD_PLAN, moduleExists: false })
    expect(r.args).toEqual(['/opt/starter.js'])
    expect(r.env['MALLOC_ARENA_MAX']).toBe('')
    expect(r.stdout.match(/launch-args module not found/g)).toHaveLength(1)
  })

  it('a module that exits non-zero: no extra args, one log line', () => {
    const r = runEntrypoint({ plan: GOOD_PLAN, exit: 1 })
    expect(r.args).toEqual(['/opt/starter.js'])
    expect(r.stdout.match(/printed no usable plan/g)).toHaveLength(1)
  })

  it('garbage output: no extra args, one log line', () => {
    const r = runEntrypoint({ plan: 'Segmentation fault\n\u0001 arg whatever\n' })
    expect(r.args).toEqual(['/opt/starter.js'])
    expect(r.stdout.match(/printed no usable plan/g)).toHaveLength(1)
  })

  it('the entrypoint no longer carries a heap formula or the allocator defaults', () => {
    expect(DOCKERFILE).not.toContain('agent_heap_mb')
    expect(DOCKERFILE).not.toContain('MALLOC_ARENA_MAX:=')
    expect(DOCKERFILE).not.toMatch(/max-old-space-size="/)
  })
})
