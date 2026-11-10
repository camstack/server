import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The machine-wide test slot (scripts/ci/test-slot.sh): at most N vitest runs
 * at once, across worktrees and agents. Every case runs against its own slot
 * directory, so a real slot held by another agent never interferes.
 */
const script = join(import.meta.dirname, '../ci/test-slot.sh')

interface SlotRun {
  readonly code: number | null
  readonly stderr: string
}

let dir = ''
let slotDir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-slot-'))
  slotDir = join(dir, 'slots')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function slotEnv(slots: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CAMSTACK_TEST_SLOT_DIR: slotDir,
    CAMSTACK_TEST_SLOTS: String(slots),
    CAMSTACK_TEST_SLOT_POLL: '0.1',
  }
}

function runAsync(slots: number, args: readonly string[]): Promise<SlotRun> {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], { env: slotEnv(slots) })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

/** A pid that certainly belongs to no running process: a child that has exited. */
function deadPid(): number {
  const child = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' })
  return Number(child.stdout.trim())
}

/** This process's niceness (a run inside a slot is itself already niced). */
function ownNiceness(): number {
  return Number(spawnSync('ps', ['-o', 'nice=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim())
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('test-slot', () => {
  it('runs the command with the agent worker cap and releases the slot', async () => {
    const out = join(dir, 'out')
    const res = await runAsync(2, ['--', 'bash', '-c', `echo "$VITEST_MAX_WORKERS $(ps -o nice= -p $$)" > ${out}`])
    expect(res.code).toBe(0)
    const [workers, niceness] = readFileSync(out, 'utf8').trim().split(/\s+/)
    expect(workers).toBe('3')
    expect(Number(niceness)).toBeGreaterThanOrEqual(Math.min(19, ownNiceness() + 15))
    expect(existsSync(join(slotDir, 'slot-0'))).toBe(false)
    expect(existsSync(join(slotDir, 'slot-1'))).toBe(false)
  })

  it('propagates the command exit status and releases the slot on failure', async () => {
    const res = await runAsync(1, ['--', 'bash', '-c', 'exit 7'])
    expect(res.code).toBe(7)
    expect(existsSync(join(slotDir, 'slot-0'))).toBe(false)
  })

  it('a second run waits for the busy slot, then runs', async () => {
    const log = join(dir, 'log')
    const first = runAsync(1, ['--', 'bash', '-c', `echo first-start >> ${log}; sleep 1; echo first-end >> ${log}`])
    await sleep(300)
    const second = runAsync(1, ['--', 'bash', '-c', `echo second >> ${log}`])
    const [a, b] = await Promise.all([first, second])
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    expect(b.stderr).toContain('busy')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['first-start', 'first-end', 'second'])
  })

  it('reclaims a slot whose owner is gone', async () => {
    mkdirSync(join(slotDir, 'slot-0'), { recursive: true })
    writeFileSync(join(slotDir, 'slot-0', 'pid'), String(deadPid()))
    const res = await runAsync(1, ['--', 'true'])
    expect(res.code).toBe(0)
    expect(res.stderr).toContain('reclaiming slot-0')
  })

  it('never reclaims a slot whose owner is alive', async () => {
    mkdirSync(join(slotDir, 'slot-0'), { recursive: true })
    writeFileSync(join(slotDir, 'slot-0', 'pid'), String(process.pid))
    const out = join(dir, 'ran')
    const pending = runAsync(1, ['--', 'bash', '-c', `touch ${out}`])
    await sleep(800)
    expect(existsSync(out)).toBe(false)
    expect(readFileSync(join(slotDir, 'slot-0', 'pid'), 'utf8')).toBe(String(process.pid))
    rmSync(join(slotDir, 'slot-0'), { recursive: true })
    const res = await pending
    expect(res.code).toBe(0)
    expect(existsSync(out)).toBe(true)
  })

  it('a normal run yields a free slot to a waiting priority run', async () => {
    mkdirSync(slotDir, { recursive: true })
    writeFileSync(join(slotDir, `priority-${process.pid}`), '')
    const out = join(dir, 'ran')
    const pending = runAsync(1, ['--', 'bash', '-c', `touch ${out}`])
    await sleep(800)
    expect(existsSync(out)).toBe(false)
    rmSync(join(slotDir, `priority-${process.pid}`))
    expect((await pending).code).toBe(0)
    expect(existsSync(out)).toBe(true)
  })

  it('a priority run keeps the caller worker count and normal niceness', async () => {
    const out = join(dir, 'out')
    const res = await new Promise<number | null>((resolve) => {
      const child = spawn(
        'bash',
        [script, '--priority', '--', 'bash', '-c', `echo "$VITEST_MAX_WORKERS $(ps -o nice= -p $$)" > ${out}`],
        { env: { ...slotEnv(1), VITEST_MAX_WORKERS: '4' } },
      )
      child.on('close', resolve)
    })
    expect(res).toBe(0)
    const [workers, niceness] = readFileSync(out, 'utf8').trim().split(/\s+/)
    expect(workers).toBe('4')
    // Priority adds no niceness of its own: it runs at the caller's.
    expect(Number(niceness)).toBe(ownNiceness())
  })
})
