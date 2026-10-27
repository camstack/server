/**
 * "Is the hub still running?" for an OFFLINE migration, answered without ever
 * opening the database (D679, D693: a live SQLite file is reached only through
 * its owner's connection, and closing any descriptor drops SQLite's locks).
 *
 * Two independent signals, each enough to refuse:
 *
 *  1. A process holds the file (or its `-wal` / `-shm`) open. Asked of the
 *     operating system (`lsof`, or `/proc/<pid>/fd` where there is no lsof),
 *     never of the database.
 *  2. A file of the set was written within `minIdleSeconds`. A hub that was
 *     killed a moment ago, or one that is about to restart, looks like this.
 *
 * It fails CLOSED: when neither process probe can run, the answer is "cannot
 * tell", which refuses, unless the operator passes `--assume-stopped` and takes
 * the responsibility explicitly.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const SQLITE_COMPANION_SUFFIXES: readonly string[] = ['', '-wal', '-shm']

export type OpenerProbe =
  | { readonly kind: 'openers'; readonly pids: readonly number[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** Asks the operating system which processes hold `files` open. */
export type ProcessProbe = (files: readonly string[]) => OpenerProbe

export interface LivenessOptions {
  readonly minIdleSeconds: number
  readonly assumeStopped: boolean
  readonly probe: ProcessProbe
  readonly now: () => number
  readonly selfPid: number
}

export type LivenessVerdict =
  | { readonly live: false; readonly notes: readonly string[] }
  | { readonly live: true; readonly reasons: readonly string[] }

export function companionsOf(dbFile: string): readonly string[] {
  return SQLITE_COMPANION_SUFFIXES.map((suffix) => `${dbFile}${suffix}`).filter((file) =>
    fs.existsSync(file),
  )
}

function lsofProbe(files: readonly string[]): OpenerProbe {
  const result = spawnSync('lsof', ['-t', '--', ...files], {
    encoding: 'utf8',
  })
  if (result.error !== undefined)
    return { kind: 'unavailable', reason: `lsof: ${result.error.message}` }
  // lsof exits 1 with no output when nothing holds any of the files open.
  if (result.status !== 0 && result.stdout.trim() === '') {
    return result.status === 1
      ? { kind: 'openers', pids: [] }
      : { kind: 'unavailable', reason: `lsof exited ${String(result.status)}` }
  }
  const pids = result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid))
  return { kind: 'openers', pids }
}

function procProbe(files: readonly string[]): OpenerProbe {
  if (!fs.existsSync('/proc/self/fd')) return { kind: 'unavailable', reason: 'no /proc' }
  const wanted = new Set(files.map((file) => fs.realpathSync(file)))
  const pids: number[] = []
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number.parseInt(entry, 10)
    if (!Number.isInteger(pid) || String(pid) !== entry) continue
    let fds: string[]
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        if (wanted.has(fs.readlinkSync(`/proc/${entry}/fd/${fd}`))) {
          pids.push(pid)
          break
        }
      } catch {
        continue
      }
    }
  }
  return { kind: 'openers', pids }
}

/** lsof first, /proc second; when both are unusable the answer is "unavailable". */
export const systemProcessProbe: ProcessProbe = (files) => {
  const viaLsof = lsofProbe(files)
  if (viaLsof.kind === 'openers') return viaLsof
  const viaProc = procProbe(files)
  return viaProc.kind === 'openers'
    ? viaProc
    : { kind: 'unavailable', reason: `${viaLsof.reason}; ${viaProc.reason}` }
}

function recentWrites(files: readonly string[], opts: LivenessOptions): readonly string[] {
  const horizon = opts.now() - opts.minIdleSeconds * 1000
  return files.flatMap((file) => {
    const mtime = fs.statSync(file).mtimeMs
    return mtime > horizon
      ? [`${path.basename(file)} was written ${Math.round((opts.now() - mtime) / 1000)}s ago`]
      : []
  })
}

/** Judge the set of database files the migration is about to touch. */
export function judgeLiveness(dbFiles: readonly string[], opts: LivenessOptions): LivenessVerdict {
  const files = dbFiles.flatMap((file) => companionsOf(file))
  if (files.length === 0) return { live: false, notes: [] }
  const reasons: string[] = []
  const notes: string[] = []
  const found = opts.probe(files)
  if (found.kind === 'openers') {
    const others = found.pids.filter((pid) => pid !== opts.selfPid)
    if (others.length > 0) reasons.push(`held open by process ${others.join(', ')}`)
  } else if (opts.assumeStopped) {
    notes.push(`process probe unavailable (${found.reason}); --assume-stopped given`)
  } else {
    reasons.push(
      `cannot tell whether a process holds the files (${found.reason}); pass --assume-stopped once you stopped the hub`,
    )
  }
  reasons.push(...recentWrites(files, opts))
  return reasons.length > 0 ? { live: true, reasons } : { live: false, notes }
}
