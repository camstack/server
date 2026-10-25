/**
 * One writer per staging directory (D667) — the guard, driven by a fake
 * process table.
 *
 * 2026-09-28: the hub recorder runner died of a V8 OOM, its 28 ffmpeg writers
 * survived it, and the respawned runner spawned 28 more into the same
 * `.rec-tmp/<id>/<profile>/` directories — 13 minutes of dual writers and 169
 * writer churns. These tests pin the rule that ends it: a foreign writer on
 * THIS directory is reaped, anything else is left alone, and a writer that
 * cannot be removed — or whose removal cannot be confirmed — is a refusal,
 * never a co-write.
 */
import { describe, expect, it } from 'vitest'
import type {
  ListedProcess,
  ProcessLister,
  ProcessSignaller,
  SignalOutcome,
} from '../process-table.js'
import {
  REFUSAL_RETRY_MS,
  type StagingClaim,
  StagingWriterReaper,
  TERM_GRACE_MS,
  writesPlaylist,
} from '../staging-writer-guard.js'

const ROOT = '/recordings'
const OUT_DIR = `${ROOT}/.rec-tmp/101/high`
const PLAYLIST = `${OUT_DIR}/live.m3u8`
const SELF_PID = 999_999

function ffmpegArgv(playlist: string, exe = 'ffmpeg'): readonly string[] {
  return [exe, '-i', 'rtsp://x', '-f', 'segment', '-segment_list', playlist, '%s.m4s']
}

function proc(
  pid: number,
  playlist: string,
  extra: Partial<ListedProcess> & { exe?: string } = {},
): ListedProcess {
  const argv = ffmpegArgv(playlist, extra.exe)
  return { pid, ppid: 1, argv, command: argv.join(' '), ageMs: 3_600_000, ...extra }
}

interface LogLine {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
  readonly meta: Record<string, unknown> | undefined
}

interface TableOpts {
  readonly ignoresTerm?: ReadonlySet<number>
  readonly unkillable?: ReadonlySet<number>
  readonly denied?: ReadonlySet<number>
  /** A process that reuses the pid after SIGTERM. */
  readonly replaceOnTerm?: ReadonlyMap<number, ListedProcess>
  /** Listing number (0-based) from which every read throws; undefined = never. */
  readonly failFrom?: number
}

/**
 * A process table that behaves like one: a SIGTERM removes a process unless
 * it ignores SIGTERM, a SIGKILL removes it unless it is unkillable, and a
 * denied pid answers EPERM to everything.
 */
function makeTable(initial: readonly ListedProcess[], opts: TableOpts = {}) {
  let alive = [...initial]
  let reads = 0
  const signals: { pid: number; signal: string }[] = []
  const lister: ProcessLister = {
    async list() {
      const n = reads++
      if (opts.failFrom !== undefined && n >= opts.failFrom) throw new Error('EACCES /proc')
      return alive
    },
  }
  const signaller: ProcessSignaller = {
    send(pid, signal): SignalOutcome {
      signals.push({ pid, signal })
      if (opts.denied?.has(pid)) return 'denied'
      if (!alive.some((p) => p.pid === pid)) return 'gone'
      const replacement = signal === 'SIGTERM' ? opts.replaceOnTerm?.get(pid) : undefined
      if (replacement !== undefined) {
        alive = alive.map((p) => (p.pid === pid ? replacement : p))
        return 'sent'
      }
      if (signal === 'SIGTERM' && opts.ignoresTerm?.has(pid)) return 'sent'
      if (opts.unkillable?.has(pid)) return 'sent'
      alive = alive.filter((p) => p.pid !== pid)
      return 'sent'
    },
  }
  return {
    lister,
    signaller,
    signals,
    alive: () => alive,
    reads: () => reads,
    advanceAge: (ms: number) => {
      alive = alive.map((row) => ({
        ...row,
        ageMs: row.ageMs === null ? null : row.ageMs + ms,
      }))
    },
    /** The process dies on its own, outside the guard. */
    drop: (pid: number) => {
      alive = alive.filter((p) => p.pid !== pid)
    },
  }
}

interface Harness {
  readonly reaper: StagingWriterReaper
  readonly lines: LogLine[]
  readonly slept: () => number
  readonly advance: (ms: number) => void
}

function makeReaper(table: ReturnType<typeof makeTable>): Harness {
  let clock = 0
  let slept = 0
  const lines: LogLine[] = []
  const advance = (ms: number): void => {
    clock += ms
    table.advanceAge(ms)
  }
  const sink =
    (level: string) =>
    (
      message: string,
      extras?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ) => {
      lines.push({ level, message, deviceId: extras?.tags?.['deviceId'], meta: extras?.meta })
    }
  const reaper = new StagingWriterReaper({
    lister: table.lister,
    signaller: table.signaller,
    logger: { debug: sink('debug'), info: sink('info'), warn: sink('warn'), error: sink('error') },
    selfPid: SELF_PID,
    sleep: async (ms) => {
      advance(ms)
      slept += ms
    },
    now: () => clock,
  })
  return {
    reaper,
    lines,
    slept: () => slept,
    advance,
  }
}

const NONE: ReadonlySet<number> = new Set()

function claimOf(overrides: Partial<StagingClaim> = {}): StagingClaim {
  return {
    deviceId: 101,
    profile: 'high',
    root: ROOT,
    outDir: OUT_DIR,
    ownPids: NONE,
    ...overrides,
  }
}

describe('StagingWriterReaper.claim — one writer per staging directory', () => {
  it('reaps a foreign writer on the same directory and says so, per camera', async () => {
    const table = makeTable([proc(4242, PLAYLIST)])
    const h = makeReaper(table)
    const result = await h.reaper.claim(claimOf())

    expect(result.outcome).toBe('clear')
    expect(table.signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    expect(table.alive()).toEqual([])
    const reaped = h.lines.filter((l) => /reaped a predecessor writer/.test(l.message))
    expect(reaped).toHaveLength(1)
    expect(reaped[0]?.level).toBe('warn')
    expect(reaped[0]?.deviceId).toBe(101)
    expect(reaped[0]?.meta).toMatchObject({ pid: 4242, ppid: 1, ageSec: 3600, profile: 'high' })
  })

  it('leaves a writer on a DIFFERENT directory alone — including a longer path that shares the prefix', async () => {
    const table = makeTable([
      proc(5001, `${ROOT}/.rec-tmp/101/low/live.m3u8`),
      proc(5002, `${OUT_DIR}/sub/live.m3u8`),
      proc(5003, `${PLAYLIST}.old`),
    ])
    const h = makeReaper(table)
    expect(await h.reaper.claim(claimOf())).toEqual({ outcome: 'clear', reaped: [] })
    expect(table.signals).toEqual([])
    expect(h.lines).toEqual([])
  })

  it('never touches a writer the caller is tracking as its own, nor this process itself', async () => {
    const table = makeTable([proc(7001, PLAYLIST, { ppid: 321 }), proc(SELF_PID, PLAYLIST)])
    const h = makeReaper(table)
    const result = await h.reaper.claim(claimOf({ ownPids: new Set([7001]) }))
    expect(result).toEqual({ outcome: 'clear', reaped: [] })
    expect(table.signals).toEqual([])
  })

  it('never signals a process that is not an ffmpeg, whatever its argv mentions', async () => {
    const table = makeTable([proc(8001, PLAYLIST, { exe: '/usr/bin/pgrep' })])
    const h = makeReaper(table)
    expect(await h.reaper.claim(claimOf())).toEqual({ outcome: 'clear', reaped: [] })
    expect(table.signals).toEqual([])
  })

  it('escalates to SIGKILL when a writer ignores SIGTERM', async () => {
    const table = makeTable([proc(4242, PLAYLIST)], { ignoresTerm: new Set([4242]) })
    const h = makeReaper(table)
    const result = await h.reaper.claim(claimOf())
    expect(result.outcome).toBe('clear')
    expect(table.signals).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ])
    expect(h.lines.find((l) => /reaped/.test(l.message))?.meta).toMatchObject({
      signal: 'SIGKILL',
    })
  })

  it('does not SIGKILL a reused pid that no longer belongs to an ffmpeg writer', async () => {
    const replacement = proc(4242, PLAYLIST, { exe: '/usr/bin/pgrep', ageMs: 0 })
    const table = makeTable([proc(4242, PLAYLIST)], {
      replaceOnTerm: new Map([[4242, replacement]]),
    })
    const h = makeReaper(table)
    const result = await h.reaper.claim(claimOf())

    expect(result.outcome).toBe('clear')
    expect(table.signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    expect(table.alive()).toHaveLength(1)
    expect(table.alive()[0]).toMatchObject({ pid: 4242, argv: replacement.argv })
  })

  it('REFUSES — and logs it per camera — when a foreign writer survives SIGKILL', async () => {
    const table = makeTable([proc(4242, PLAYLIST)], { unkillable: new Set([4242]) })
    const h = makeReaper(table)
    const result = await h.reaper.claim(claimOf())
    expect(result.outcome).toBe('refused')
    const refusal = h.lines.find((l) => /REFUSED to spawn/.test(l.message))
    expect(refusal?.level).toBe('error')
    expect(refusal?.deviceId).toBe(101)
    expect(refusal?.meta).toMatchObject({ pid: 4242, reason: 'survived', attempts: 1 })
    expect(h.lines.some((l) => /reaped/.test(l.message))).toBe(false)
  })

  it('says it could NOT check when the table cannot be read — never "clear"', async () => {
    const table = makeTable([proc(4242, PLAYLIST)], { failFrom: 0 })
    const h = makeReaper(table)
    const result = await h.reaper.claim(claimOf())
    expect(result.outcome).toBe('unverified')
    expect(h.lines).toHaveLength(1)
    expect(h.lines[0]).toMatchObject({ level: 'warn', deviceId: 101 })
    expect(h.lines[0]?.message).toMatch(/WITHOUT checking/)
  })

  it('REFUSES — and sends no SIGKILL — when the table stops answering after the SIGTERM', async () => {
    // Read 0 finds the writer; every read after the SIGTERM fails. Its death
    // cannot be confirmed, and a SIGKILL to a pid nobody re-read is refused.
    const table = makeTable([proc(4242, PLAYLIST)], {
      ignoresTerm: new Set([4242]),
      failFrom: 1,
    })
    const h = makeReaper(table)
    const result = await h.reaper.claim(claimOf())

    expect(result.outcome).toBe('refused')
    expect(result.outcome === 'refused' ? result.survivors[0]?.reason : null).toBe(
      'table-unreadable',
    )
    expect(table.signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    // One retry before giving up, not a silent single failure.
    expect(table.reads()).toBe(3)
  })

  it('refuses at once, without waiting a grace, when the kernel denies the signal (EPERM)', async () => {
    const table = makeTable([proc(4242, PLAYLIST)], { denied: new Set([4242]) })
    const h = makeReaper(table)
    const result = await h.reaper.claim(claimOf())

    expect(result.outcome === 'refused' ? result.survivors[0]?.reason : null).toBe('denied')
    expect(table.signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    expect(h.slept()).toBe(0)
  })
})

describe('StagingWriterReaper — a refused directory is held, and says so once', () => {
  it('refuses a second claim inside the hold without a table read or a signal, at DEBUG', async () => {
    const table = makeTable([proc(4242, PLAYLIST)], { unkillable: new Set([4242]) })
    const h = makeReaper(table)
    await h.reaper.claim(claimOf())
    const readsAfterFirst = table.reads()
    const signalsAfterFirst = table.signals.length

    h.advance(REFUSAL_RETRY_MS - 1_000 - TERM_GRACE_MS)
    const second = await h.reaper.claim(claimOf())

    expect(second.outcome === 'refused' ? second.survivors[0]?.reason : null).toBe('held')
    expect(table.reads()).toBe(readsAfterFirst)
    expect(table.signals.length).toBe(signalsAfterFirst)
    expect(h.lines.filter((l) => l.level === 'error')).toHaveLength(1)
    expect(h.lines.at(-1)?.level).toBe('debug')
  })

  it('retries after the hold, and a repeat of the SAME survivor is DEBUG, not a second ERROR', async () => {
    const table = makeTable([proc(4242, PLAYLIST)], { unkillable: new Set([4242]) })
    const h = makeReaper(table)
    await h.reaper.claim(claimOf())
    h.advance(REFUSAL_RETRY_MS)
    const again = await h.reaper.claim(claimOf())

    expect(again.outcome === 'refused' ? again.survivors[0]?.reason : null).toBe('survived')
    expect(table.signals.filter((s) => s.signal === 'SIGKILL')).toHaveLength(2)
    expect(h.lines.filter((l) => l.level === 'error')).toHaveLength(1)
    const repeat = h.lines.find((l) => /still refused/.test(l.message))
    expect(repeat?.level).toBe('debug')
    expect(repeat?.meta).toMatchObject({ attempts: 2 })
  })

  it('clears the hold — and says so — once the foreign writer is gone', async () => {
    const table = makeTable([proc(4242, PLAYLIST)], { unkillable: new Set([4242]) })
    const h = makeReaper(table)
    await h.reaper.claim(claimOf())
    table.drop(4242)
    h.advance(REFUSAL_RETRY_MS)
    const after = await h.reaper.claim(claimOf())

    expect(after).toEqual({ outcome: 'clear', reaped: [] })
    const cleared = h.lines.find((l) => /no longer refused/.test(l.message))
    expect(cleared?.level).toBe('info')
    expect(cleared?.deviceId).toBe(101)
  })
})

describe('StagingWriterReaper.sweep — every foreign writer under a staging root', () => {
  it('at boot: reaps a writer whose camera will never be attached again, and nothing outside the roots', async () => {
    const table = makeTable([
      proc(4101, `${ROOT}/.rec-tmp/77/high/live.m3u8`),
      proc(4102, '/media-fast/recordingsLow/.rec-tmp/77/low/live.m3u8'),
      proc(4103, '/elsewhere/.rec-tmp/77/high/live.m3u8'),
      proc(4104, `${ROOT}/.rec-tmp/78/high/live.m3u8`),
    ])
    const h = makeReaper(table)
    const result = await h.reaper.sweep({
      roots: [ROOT, '/media-fast/recordingsLow'],
      deviceId: null,
      ownPids: new Set([4104]),
    })

    expect(result.outcome).toBe('swept')
    const reaped = result.outcome === 'swept' ? result.reaped : []
    expect(reaped.map((r) => [r.pid, r.target.deviceId, r.target.profile]).toSorted()).toEqual([
      [4101, 77, 'high'],
      [4102, 77, 'low'],
    ])
    // One window for all of them: SIGTERMs first, together.
    expect(table.signals).toEqual([
      { pid: 4101, signal: 'SIGTERM' },
      { pid: 4102, signal: 'SIGTERM' },
    ])
    expect(h.lines.filter((l) => /reaped/.test(l.message)).map((l) => l.deviceId)).toEqual([77, 77])
    expect(h.lines.find((l) => /boot sweep/.test(l.message))?.meta).toMatchObject({
      found: 2,
      reaped: 2,
      refused: 0,
    })
  })

  it('for one camera: only that camera’s directories, on every root', async () => {
    const table = makeTable([
      proc(4201, `${ROOT}/.rec-tmp/101/high/live.m3u8`),
      proc(4203, `${ROOT}/.rec-tmp/101/low/live.m3u8`),
      proc(4202, `${ROOT}/.rec-tmp/616/high/live.m3u8`),
    ])
    const h = makeReaper(table)
    const result = await h.reaper.sweep({ roots: [ROOT], deviceId: 101, ownPids: NONE })
    expect(result.outcome === 'swept' ? result.reaped.map((r) => r.pid) : []).toEqual([4201, 4203])
    expect(table.signals).toEqual([
      { pid: 4201, signal: 'SIGTERM' },
      { pid: 4203, signal: 'SIGTERM' },
    ])
    // One initial table read and one shared confirmation read — never one
    // independent TERM/KILL window per profile.
    expect(table.reads()).toBe(2)
    expect(table.alive().map((p) => p.pid)).toEqual([4202])
  })
})

describe('writesPlaylist — recognising a writer from a joined `ps` command line', () => {
  const psRow = (command: string): ListedProcess => ({
    pid: 1,
    ppid: 1,
    argv: null,
    command,
    ageMs: null,
  })

  it('matches the exact path, also with spaces in it', () => {
    const dir = '/Volumes/Cam Disk/.rec-tmp/101/high'
    const row = psRow(`ffmpeg -segment_list ${dir}/live.m3u8 -segment_list_type m3u8`)
    expect(writesPlaylist(row, `${dir}/live.m3u8`)).toBe(true)
  })

  it('does not match a path that merely starts with it', () => {
    expect(writesPlaylist(psRow(`ffmpeg -segment_list ${PLAYLIST}.old x`), PLAYLIST)).toBe(false)
    expect(writesPlaylist(psRow(`ffmpeg -segment_list /x${PLAYLIST}`), PLAYLIST)).toBe(false)
  })

  it('matches at the end of the line', () => {
    expect(writesPlaylist(psRow(`ffmpeg -segment_list ${PLAYLIST}`), PLAYLIST)).toBe(true)
  })
})
