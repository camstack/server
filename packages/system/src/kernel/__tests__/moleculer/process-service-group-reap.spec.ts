/**
 * D668 — a runner owns a process group, and the kernel reaps it on every runner exit.
 *
 * 2026-09-28 10:21 CEST: the hub's recorder runner died of SIGABRT (V8 OOM). It ran no
 * shutdown hook, so its 28 ffmpeg writers survived as orphans (ffmpeg ignores SIGPIPE
 * and does not quit on stdin EOF) and the respawned runner started 28 more into the same
 * staging directories: 13 minutes of two writers per camera, on every camera.
 *
 * Three claims, each red without the fix:
 *  1. a runner is spawned as a group leader, and its exit signals the NEGATIVE pgid
 *     (SIGTERM, then SIGKILL for a group that outlives the grace);
 *  2. with a REAL process: a grandchild the runner-like fixture spawned — one of them
 *     ignoring SIGTERM — is gone within 2 s of the fixture being SIGKILLed;
 *  3. a respawn (crash backoff, operator restart) happens only AFTER the reap.
 *  4. normal and SIGKILL parent loss both remove a detached runner's whole tree.
 */
import * as cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ServiceBroker } from 'moleculer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProcessService } from '../../moleculer/process-service.js'
import {
  defaultProcessGroupOps,
  type GroupMember,
  killOwnRunnerGroupAfterParentLoss,
  ownedRunnerGroupIds,
  parsePsGroupMembers,
  type ProcessGroupOps,
  reapProcessGroup,
  resetRunnerShutdownForTests,
  signalAllRunnerGroups,
  startRunnerParentDeathWatchdog,
} from '../../moleculer/runner-process-group.js'

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => boolean
  exitCode: number | null
  signalCode: string | null
}

function makeFakeChild(pid: number): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.pid = pid
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.exitCode = null
  ee.signalCode = null
  ee.kill = (sig?: string) => {
    if (ee.exitCode !== null || ee.signalCode !== null) return false
    setImmediate(() => {
      ee.signalCode = sig ?? 'SIGTERM'
      ee.emit('exit', null, ee.signalCode)
    })
    return true
  }
  return ee
}

function crash(child: FakeChild, signal: string): void {
  child.signalCode = signal
  child.emit('exit', null, signal)
}

const execFileAsync = promisify(cp.execFile)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

function esrch(): Error {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
}

/** A deferred the test resolves by hand. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * A fake OS for one group: `alive` members answer every signal until SIGKILL (or, for a
 * polite group, SIGTERM) empties it. Records every call in order, next to spawns.
 */
function fakeGroups(opts: {
  readonly log: string[]
  readonly members: readonly GroupMember[]
  readonly ignoresTerm: boolean
  readonly listGate?: Promise<void>
}): ProcessGroupOps {
  const emptied = new Set<number>()
  return {
    kill: (pid, signal) => {
      opts.log.push(`kill ${pid} ${String(signal)}`)
      if (pid > 0) {
        // A per-member probe: alive while its group has not been emptied.
        const inGroup = opts.members.some((m) => m.pid === pid)
        if (!inGroup || emptied.size > 0) throw esrch()
        return
      }
      const pgid = -pid
      if (emptied.has(pgid)) throw esrch()
      if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !opts.ignoresTerm)) emptied.add(pgid)
    },
    listMembers: async (pgid) => {
      if (opts.listGate) await opts.listGate
      return emptied.has(pgid) ? [] : opts.members
    },
    sleep: () => Promise.resolve(),
    graceMs: 300,
  }
}

describe('process-service D668: a runner owns a process group', { timeout: 20_000 }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-group-reap-'))
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function harness(
    nodeId: string,
    groups: ProcessGroupOps,
    platform: NodeJS.Platform,
    log: string[] = [],
  ) {
    const spawned: { child: FakeChild; opts: cp.SpawnOptions }[] = []
    let pid = 91_000 + Math.floor(Math.random() * 1000) * 10
    const spawnFn = (_c: string, _a: readonly string[], opts: cp.SpawnOptions): cp.ChildProcess => {
      const child = makeFakeChild(++pid)
      spawned.push({ child, opts })
      log.push(`spawn ${child.pid}`)
      const env = opts.env ?? {}
      setImmediate(() =>
        child.stdout.emit(
          'data',
          Buffer.from(`READY:${env['CAMSTACK_PARENT_NODE_ID']}/${env['CAMSTACK_RUNNER_ID']}\n`),
        ),
      )
      return child as unknown as cp.ChildProcess
    }
    const broker = new ServiceBroker({ nodeID: nodeId, transporter: 'Fake', logger: false })
    broker.createService(
      createProcessService(nodeId, tmpDir, { spawnFn, processGroups: groups, platform }),
    )
    return { broker, spawned, log }
  }

  it('spawns a POSIX runner detached (group leader) and a Windows one not', async () => {
    const posix = harness(
      'hub-pg-posix',
      fakeGroups({ log: [], members: [], ignoresTerm: false }),
      'linux',
    )
    const win = harness(
      'hub-pg-win',
      fakeGroups({ log: [], members: [], ignoresTerm: false }),
      'win32',
    )
    await posix.broker.start()
    await win.broker.start()
    const addons = [{ addonId: 'rec', addonDir: '/tmp/rec' }]
    await posix.broker.call('$process.spawnRunner', { runnerId: 'rec', addons })
    await win.broker.call('$process.spawnRunner', { runnerId: 'rec', addons })
    expect(posix.spawned[0]?.opts.detached).toBe(true)
    expect(win.spawned[0]?.opts.detached).toBe(false)
    expect(ownedRunnerGroupIds()).toContain(posix.spawned[0]?.child.pid)
    expect(ownedRunnerGroupIds()).not.toContain(win.spawned[0]?.child.pid)
    await posix.broker.call('$process.stop', { name: 'rec' })
    await win.broker.call('$process.stop', { name: 'rec' })
    await posix.broker.stop()
    await win.broker.stop()
  })

  it('a SIGABRT exit SIGTERMs the negative pgid, then SIGKILLs a group that outlives the grace', async () => {
    const calls: string[] = []
    const ffmpeg: GroupMember[] = [
      { pid: 5001, command: 'ffmpeg' },
      { pid: 5002, command: 'ffmpeg' },
    ]
    const groups = fakeGroups({ log: calls, members: ffmpeg, ignoresTerm: true })
    const h = harness('hub-pg-abrt', groups, 'linux')
    await h.broker.start()
    await h.broker.call('$process.spawnRunner', {
      runnerId: 'recorder',
      addons: [{ addonId: 'recorder', addonDir: '/tmp/recorder' }],
    })
    const runner = h.spawned[0]!.child
    crash(runner, 'SIGABRT')
    await waitFor(() => calls.includes(`kill ${-runner.pid} SIGKILL`), 5_000, 'group SIGKILL')
    expect(calls[0]).toBe(`kill ${-runner.pid} SIGTERM`)
    // Every real signal addressed the GROUP, never the (already dead) leader alone;
    // the only positive-pid calls are signal-0 probes of the members.
    const signals = calls.filter((c) => !c.endsWith(' 0'))
    expect(signals.every((c) => c.startsWith(`kill ${-runner.pid} `))).toBe(true)
    await waitFor(() => !ownedRunnerGroupIds().includes(runner.pid), 2_000, 'group release')
    await h.broker.call('$process.stop', { name: 'recorder' }).catch(() => undefined)
    await h.broker.stop()
  })

  it('the crash respawn waits for the reap: the successor never co-exists with the orphans', async () => {
    const listGate = gate()
    // ONE ordered log for signals and spawns.
    const log: string[] = []
    const groups = fakeGroups({
      log,
      members: [{ pid: 6001, command: 'ffmpeg' }],
      ignoresTerm: false,
      listGate: listGate.promise,
    })
    const h = harness('hub-pg-order', groups, 'linux', log)
    await h.broker.start()
    await h.broker.call('$process.spawnRunner', {
      runnerId: 'recorder',
      addons: [{ addonId: 'recorder', addonDir: '/tmp/recorder' }],
    })
    const first = h.spawned[0]!.child
    crash(first, 'SIGABRT')
    // The first backoff is 500 ms. Hold the reap well past it: no respawn may happen.
    await sleep(900)
    expect(h.spawned.length, 'respawned while the dead runner’s group was still being reaped').toBe(
      1,
    )
    listGate.open()
    await waitFor(() => h.spawned.length === 2, 5_000, 'respawn after reap')
    const termAt = log.indexOf(`kill ${-first.pid} SIGTERM`)
    const respawnAt = log.indexOf(`spawn ${h.spawned[1]!.child.pid}`)
    expect(termAt).toBeGreaterThanOrEqual(0)
    expect(respawnAt).toBeGreaterThan(termAt)
    await h.broker.call('$process.stop', { name: 'recorder' })
    await h.broker.stop()
  })

  it('an operator restart spawns the new runner only after the old group is reaped', async () => {
    const listGate = gate()
    const calls: string[] = []
    const groups = fakeGroups({
      log: calls,
      members: [{ pid: 7001, command: 'llama-server' }],
      ignoresTerm: false,
      listGate: listGate.promise,
    })
    const h = harness('hub-pg-restart', groups, 'linux')
    await h.broker.start()
    await h.broker.call('$process.spawnRunner', {
      runnerId: 'ai',
      addons: [{ addonId: 'ai', addonDir: '/tmp/ai' }],
    })
    const restarting = h.broker.call('$process.restart', { name: 'ai' })
    await sleep(200)
    expect(h.spawned.length, 'restart spawned before the old group was reaped').toBe(1)
    listGate.open()
    await restarting
    expect(h.spawned.length).toBe(2)
    expect(calls).toContain(`kill ${-h.spawned[0]!.child.pid} SIGTERM`)
    await h.broker.call('$process.stop', { name: 'ai' })
    await h.broker.stop()
  })

  it('signalAllRunnerGroups reaches every owned group by its negative pgid', async () => {
    const calls: string[] = []
    const h = harness(
      'hub-pg-signal',
      fakeGroups({ log: calls, members: [], ignoresTerm: true }),
      'linux',
    )
    await h.broker.start()
    await h.broker.call('$process.spawnRunner', {
      runnerId: 'broker-r',
      addons: [{ addonId: 'stream-broker', addonDir: '/tmp/sb' }],
    })
    const pid = h.spawned[0]!.child.pid
    signalAllRunnerGroups('SIGTERM')
    // Signalling every group IS a shutdown; later cases in this file are not.
    resetRunnerShutdownForTests()
    expect(calls).toContain(`kill ${-pid} SIGTERM`)
    await h.broker.call('$process.stop', { name: 'broker-r' })
    await h.broker.stop()
  })

  it('broker shutdown waits until every runner group reap finishes', async () => {
    const listGate = gate()
    const calls: string[] = []
    const h = harness(
      'agent-pg-stop',
      fakeGroups({
        log: calls,
        members: [{ pid: 8101, command: 'ffmpeg' }],
        ignoresTerm: false,
        listGate: listGate.promise,
      }),
      'darwin',
    )
    await h.broker.start()
    await h.broker.call('$process.spawnRunner', {
      runnerId: 'recorder',
      addons: [{ addonId: 'recorder', addonDir: '/tmp/recorder' }],
    })

    let stopped = false
    const stopping = h.broker.stop().then(() => {
      stopped = true
    })
    await sleep(200)
    expect(stopped, 'broker.stop returned while its runner group was still being reaped').toBe(
      false,
    )

    listGate.open()
    await stopping
    expect(stopped).toBe(true)
    expect(calls).toContain(`kill ${-h.spawned[0]!.child.pid} SIGTERM`)
  })
})

describe('runner-process-group primitives', () => {
  it('never addresses pgid 0, 1 or its own process — kill(-1) is every process', async () => {
    const calls: string[] = []
    const ops: ProcessGroupOps = {
      kill: (pid, sig) => {
        calls.push(`${pid} ${String(sig)}`)
      },
      listMembers: () => Promise.resolve([]),
      sleep: () => Promise.resolve(),
      graceMs: 0,
    }
    for (const pgid of [0, 1, -5, process.pid, Number.NaN]) {
      const result = await reapProcessGroup(pgid, ops)
      expect(result.error).toMatch(/refused/)
    }
    expect(calls).toEqual([])
  })

  it('treats ESRCH on the first SIGTERM as an already-empty group, not an error', async () => {
    const result = await reapProcessGroup(424_242, {
      kill: () => {
        throw esrch()
      },
      listMembers: () => Promise.resolve([]),
      sleep: () => Promise.resolve(),
      graceMs: 100,
    })
    expect(result).toMatchObject({ alreadyEmpty: true, error: null, killed: [] })
  })

  it('reads one group out of a ps table, zombies and other groups excluded', () => {
    const table = [
      ' 3890  3890 Ss   /usr/bin/node',
      ' 3904  3890 S    /usr/lib/jellyfin-ffmpeg/ffmpeg',
      ' 3905  3890 Z    ffmpeg',
      ' 4000  4000 S    /usr/bin/sleep',
    ].join('\n')
    expect(parsePsGroupMembers(table, 3890)).toEqual([
      { pid: 3890, command: 'node' },
      { pid: 3904, command: 'ffmpeg' },
    ])
  })

  it('hard-kills only the runner-owned negative pgid after parent loss', () => {
    const calls: string[] = []
    expect(
      killOwnRunnerGroupAfterParentLoss('darwin', (pid, signal) => {
        calls.push(`${pid} ${String(signal)}`)
      }),
    ).toBe(true)
    expect(calls).toEqual([`${-process.pid} SIGKILL`])

    expect(
      killOwnRunnerGroupAfterParentLoss('win32', (pid, signal) => {
        calls.push(`${pid} ${String(signal)}`)
      }),
    ).toBe(false)
    expect(calls).toEqual([`${-process.pid} SIGKILL`])
  })

  it('fires the parent-death watchdog once when the direct parent changes', async () => {
    let currentPpid = 500
    let deaths = 0
    const timer = startRunnerParentDeathWatchdog(
      () => {
        deaths += 1
      },
      {
        initialPpid: 500,
        readPpid: () => currentPpid,
        intervalMs: 5,
      },
    )
    expect(timer).not.toBeNull()
    currentPpid = 1
    await waitFor(() => deaths === 1, 500, 'parent-death callback')
    currentPpid = 2
    await sleep(20)
    expect(deaths).toBe(1)
  })
})

// ── (2) A REAL process tree ──────────────────────────────────────────────────

const FIXTURE = `
const { spawn } = require('node:child_process')
// A polite grandchild, and one that IGNORES SIGTERM — an ffmpeg that ignores
// SIGPIPE and never reads stdin EOF is exactly as deaf to its dead parent. The
// deaf child announces only after its handler is installed, so the test cannot
// race the signal against child startup and pass for the wrong reason.
const polite = spawn('sleep', ['60'], { stdio: 'ignore' })
const deaf = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("READY\\\\n"); setInterval(() => {}, 1000)'], {
  stdio: ['ignore', 'pipe', 'ignore'],
})
deaf.stdout.once('data', () => {
  process.stdout.write('GRANDCHILDREN:' + polite.pid + ',' + deaf.pid + '\\n')
})
setInterval(() => {}, 1000)
`

/**
 * Which of `pids` are alive. Signal 0 is definitive for "gone"; a pid that still answers
 * may be a zombie its new parent has not reaped yet, which is dead for this purpose, so
 * those — and only those — are confirmed with ONE `ps` for the lot.
 */
async function livePids(pids: readonly number[]): Promise<readonly number[]> {
  const answering = pids.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  if (answering.length === 0) return []
  try {
    // Async on purpose: a synchronous `ps` in the poll blocks the event loop the reap
    // itself runs on, and measured as ~0.5 s of the 2 s budget.
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,stat=', '-p', answering.join(',')])
    return stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(
        ([pid, stat]) =>
          pid !== undefined && pid !== '' && stat !== undefined && !stat.startsWith('Z'),
      )
      .map(([pid]) => Number(pid))
  } catch {
    return [] // `ps -p` exits 1 when none of them exists any more
  }
}

describe.skipIf(process.platform === 'win32')(
  'process-service D668: a SIGKILLed runner leaves no grandchild behind (real processes)',
  { timeout: 20_000 },
  () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-group-real-'))
    const fixture = path.join(tmpDir, 'runner-fixture.cjs')
    const grandchildren: number[] = []
    const runners: cp.ChildProcess[] = []
    let firstSpawn: ((pids: readonly number[]) => void) | null = null
    const firstGrandchildren = new Promise<readonly number[]>((resolve) => {
      firstSpawn = resolve
    })

    // The service's own spawn options (detached, stdio) reach the REAL spawn; only the
    // script is swapped for the fixture.
    const spawnFn = (
      command: string,
      _args: readonly string[],
      opts: cp.SpawnOptions,
    ): cp.ChildProcess => {
      const child = cp.spawn(command, [fixture], opts)
      runners.push(child)
      child.stdout?.on('data', (data: Buffer) => {
        const m = /GRANDCHILDREN:(\d+),(\d+)/.exec(data.toString())
        if (!m) return
        const pids = [Number(m[1]), Number(m[2])]
        grandchildren.push(...pids)
        firstSpawn?.(pids)
        firstSpawn = null
      })
      return child
    }

    const broker = new ServiceBroker({ nodeID: 'hub-pg-real', transporter: 'Fake', logger: false })

    beforeAll(async () => {
      fs.writeFileSync(fixture, FIXTURE)
      broker.createService(
        createProcessService('hub-pg-real', tmpDir, {
          spawnFn,
          // Real signals and a real process table; a shorter grace so the deaf
          // grandchild's SIGKILL lands inside the 2 s the test allows.
          processGroups: { ...defaultProcessGroupOps, graceMs: 300 },
        }),
      )
      await broker.start()
    })

    afterAll(async () => {
      await broker.call('$process.stop', { name: 'fixture' }).catch(() => undefined)
      await broker.stop()
      for (const pid of grandchildren) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* gone — the expected case */
        }
      }
      for (const r of runners) r.kill('SIGKILL')
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('reaps a polite and a SIGTERM-deaf grandchild within 2 s of the runner being SIGKILLed', async () => {
      await broker.call('$process.spawnRunner', {
        runnerId: 'fixture',
        addons: [{ addonId: 'fixture', addonDir: tmpDir }],
      })
      const [polite, deaf] = await firstGrandchildren
      expect(await livePids([polite!, deaf!])).toEqual([polite, deaf])

      process.kill(runners[0]!.pid!, 'SIGKILL')
      const killedAt = Date.now()
      await waitFor(
        async () => (await livePids([polite!, deaf!])).length === 0,
        2_000,
        'grandchildren reaped',
      ).catch(async (err: unknown) => {
        const alive = await livePids([polite!, deaf!])
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} — still alive: ` +
            `${alive.join(',')} (polite=${polite}, deaf=${deaf}) ` +
            `after ${Date.now() - killedAt} ms`,
        )
      })
    })
  },
)

// ── Parent process loss: the parent itself cannot reap ──────────────────────

function parentLossFixtureSource(): string {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '../../moleculer/runner-process-group.ts'),
  ).href
  return `
import { spawn } from 'node:child_process'
import {
  killOwnRunnerGroupAfterParentLoss,
  registerRunnerGroup,
  startRunnerParentDeathWatchdog,
} from ${JSON.stringify(moduleUrl)}

const role = process.argv[2]
if (role === 'parent') {
  const runner = spawn(process.execPath, ['--import', 'tsx', process.argv[1], 'runner'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.pipe(process.stdout)
  runner.stderr.pipe(process.stderr)
  registerRunnerGroup(runner.pid, {
    runnerId: 'parent-loss-fixture',
    kill: (pid, signal) => process.kill(pid, signal),
  })
  process.stdout.write('PARENT:' + process.pid + ',' + runner.pid + '\\n')
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
} else {
  const polite = spawn('sleep', ['60'], { stdio: 'ignore' })
  const deaf = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("READY\\\\n"); setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  deaf.stdout.once('data', () => {
    process.stdout.write('TREE:' + process.pid + ',' + polite.pid + ',' + deaf.pid + '\\n')
  })
  startRunnerParentDeathWatchdog(
    () => {
      if (!killOwnRunnerGroupAfterParentLoss()) process.exit(0)
    },
    { intervalMs: 25 },
  )
  setInterval(() => {}, 1000)
}
`
}

describe.skipIf(process.platform === 'win32')(
  'D668 parent-loss backstops (real processes)',
  { timeout: 45_000 },
  () => {
    const tmpDir = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-parent-loss-')))
    const fixture = path.join(tmpDir, 'parent-loss-fixture.mjs')

    beforeAll(() => {
      fs.writeFileSync(fixture, parentLossFixtureSource())
    })

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    async function runCase(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
      const parent = cp.spawn(process.execPath, ['--import', 'tsx', fixture, 'parent'], {
        cwd: path.resolve(__dirname, '../../../../../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let tree: readonly [number, number, number] | null = null
      parent.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const match = /TREE:(\d+),(\d+),(\d+)/.exec(stdout)
        if (match) tree = [Number(match[1]), Number(match[2]), Number(match[3])]
      })
      parent.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      try {
        await waitFor(() => tree !== null, 30_000, 'parent-loss fixture startup')
        const [runner, polite, deaf] = tree!
        expect(await livePids([runner, polite, deaf])).toEqual([runner, polite, deaf])

        parent.kill(signal)
        const killedAt = Date.now()
        await waitFor(
          async () => (await livePids([runner, polite, deaf])).length === 0,
          2_000,
          `${signal} parent-loss tree cleanup`,
        ).catch(async (err: unknown) => {
          const alive = await livePids([runner, polite, deaf])
          throw new Error(
            `${err instanceof Error ? err.message : String(err)} — still alive: ` +
              `${alive.join(',')} (runner=${runner}, polite=${polite}, deaf=${deaf}) ` +
              `after ${Date.now() - killedAt} ms; stderr=${stderr}`,
          )
        })
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
        const cleanupTree = tree as readonly [number, number, number] | null
        if (cleanupTree !== null) {
          const [runner, polite, deaf] = cleanupTree
          const members = await defaultProcessGroupOps.listMembers(runner)
          if (members?.some((member) => member.pid === polite || member.pid === deaf)) {
            try {
              process.kill(-runner, 'SIGKILL')
            } catch {
              /* already gone */
            }
          }
        }
      }
    }

    it('a normal parent exit cannot leave its runner group behind', async () => {
      await runCase('SIGTERM')
    })

    it('a SIGKILLed parent is detected by the runner before grandchildren escape', async () => {
      await runCase('SIGKILL')
    })
  },
)
