/**
 * The agent root's old-space ceiling: one formula, three launch surfaces.
 *
 *  - the container entrypoint (`agent_heap_mb` in the Dockerfile) — run here
 *    through a real `sh` against fake `/proc/meminfo` and cgroup files;
 *  - the Electron shell's child (`nodeArgs`);
 *  - the Windows service supervisor's spawn.
 *
 * The shell and TypeScript answers must agree, and every launch surface must
 * actually carry the flag (the wiring checks fail when it is removed).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_HEAP_CAP_MB,
  AGENT_HEAP_FLOOR_MB,
  agentHeapCeilingMb,
  agentHeapNodeArgs,
} from '../agent-heap-flag'

const GB = 1024 ** 3
const ROOT = resolve(__dirname, '../../../..')

function entrypointFunction(): string {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  const begin = dockerfile.indexOf('# [agent-heap-begin]')
  const end = dockerfile.indexOf('# [agent-heap-end]')
  expect(begin).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(begin)
  return dockerfile.slice(begin, end)
}

function shellAnswer(
  totalBytes: number,
  extraEnv: Record<string, string> = {},
  cgroup?: string,
): number {
  const dir = mkdtempSync(join(tmpdir(), 'agent-heap-'))
  const meminfo = join(dir, 'meminfo')
  writeFileSync(meminfo, `MemTotal:       ${Math.floor(totalBytes / 1024)} kB\nMemFree: 1 kB\n`)
  const cgroupFile = join(dir, 'memory.max')
  writeFileSync(cgroupFile, cgroup ?? 'max\n')
  const out = execFileSync('sh', ['-c', `${entrypointFunction()}\nagent_heap_mb`], {
    env: {
      PATH: process.env['PATH'] ?? '',
      CAMSTACK_MEMINFO: meminfo,
      CAMSTACK_CGROUP_MEM_MAX: cgroupFile,
      ...extraEnv,
    },
    encoding: 'utf8',
  })
  return Number(out.trim())
}

describe('agentHeapCeilingMb', () => {
  it('is a quarter of RAM between the floor and the cap', () => {
    expect(agentHeapCeilingMb(2 * GB)).toBe(AGENT_HEAP_FLOOR_MB)
    expect(agentHeapCeilingMb(4 * GB)).toBe(AGENT_HEAP_FLOOR_MB)
    expect(agentHeapCeilingMb(8 * GB)).toBe(2048)
    expect(agentHeapCeilingMb(64 * GB)).toBe(AGENT_HEAP_CAP_MB)
  })

  it('never goes under the generous floor, whatever the host reports', () => {
    expect(agentHeapCeilingMb(0)).toBe(AGENT_HEAP_FLOOR_MB)
    expect(agentHeapCeilingMb(Number.NaN)).toBe(AGENT_HEAP_FLOOR_MB)
    expect(AGENT_HEAP_FLOOR_MB).toBeGreaterThanOrEqual(1536)
  })

  it('honours CAMSTACK_AGENT_HEAP_MB only when it is a positive integer', () => {
    expect(agentHeapCeilingMb(8 * GB, { CAMSTACK_AGENT_HEAP_MB: '3000' })).toBe(3000)
    expect(agentHeapCeilingMb(8 * GB, { CAMSTACK_AGENT_HEAP_MB: 'lots' })).toBe(2048)
    expect(agentHeapCeilingMb(8 * GB, { CAMSTACK_AGENT_HEAP_MB: '0' })).toBe(2048)
  })

  it('renders the argv flag', () => {
    expect(agentHeapNodeArgs(8 * GB)).toEqual(['--max-old-space-size=2048'])
  })
})

describe('the container entrypoint agrees with the TypeScript formula', () => {
  for (const gb of [2, 4, 6, 8, 16, 64]) {
    it(`${gb} GB host`, () => {
      expect(shellAnswer(gb * GB)).toBe(agentHeapCeilingMb(gb * GB))
    })
  }

  it('the override agrees, and a bad override falls back to the formula', () => {
    expect(shellAnswer(8 * GB, { CAMSTACK_AGENT_HEAP_MB: '3000' })).toBe(3000)
    expect(shellAnswer(8 * GB, { CAMSTACK_AGENT_HEAP_MB: 'x1' })).toBe(2048)
  })

  it('a cgroup limit below host RAM lowers it, down to the floor', () => {
    expect(shellAnswer(64 * GB, {}, String(8 * GB))).toBe(2048)
    expect(shellAnswer(64 * GB, {}, String(1 * GB))).toBe(AGENT_HEAP_FLOOR_MB)
  })
})

describe('every launch surface carries the flag', () => {
  it('the container entrypoint execs node with it for role=agent only', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    expect(dockerfile).toMatch(
      /"\$\{CAMSTACK_ROLE:-hub\}" = "agent" \]; then\s+exec gosu camstack:camstack node --max-old-space-size="\$\(agent_heap_mb\)"/,
    )
  })

  it('the Electron shell passes it as nodeArgs for the agent role', () => {
    const main = readFileSync(join(__dirname, '../main.ts'), 'utf8')
    expect(main).toMatch(/agentHeapNodeArgs\(/)
    expect(main).toMatch(/nodeArgs/)
  })

  it('the Windows service supervisor spawns the starter with it', () => {
    const supervisor = readFileSync(
      join(__dirname, '../windows-service/service-supervisor-main.ts'),
      'utf8',
    )
    expect(supervisor).toMatch(/spawn\(process\.execPath, \[\.\.\.agentHeapNodeArgs\(/)
  })
})
