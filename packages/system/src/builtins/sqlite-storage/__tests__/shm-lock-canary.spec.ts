/**
 * The canary that says whether this process still holds SQLite's DMS lock on
 * its `-shm` (D679). The parse and the transitions run everywhere; the last
 * block runs the real thing on Linux (CI), where `/proc/locks` exists — and
 * reproduces the loss the canary exists to see, by doing to the `-shm`
 * exactly what the retired checkpoint worker did once a second.
 */
import { closeSync, openSync, promises as fs, readSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  holdsDmsLock,
  parseProcLocks,
  SQLITE_SHM_DMS_BYTE,
  ShmLockCanary,
  type ShmLockCanaryDeps,
} from '../shm-lock-canary.js'

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

function makeLogger(): { logger: IScopedLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = []
  const push =
    (level: LoggedLine['level']) =>
    (message: string, extras?: LogExtras): void => {
      lines.push(extras === undefined ? { level, message } : { level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

// The live hub's /proc/locks on 2026-09-29, runner pid 3490531: the database
// inode is locked, the -shm inode (3769403373) is not.
const LIVE_LOST = [
  '1: POSIX  ADVISORY  READ 3490531 08:31:3760032966 1073741826 1073742335',
  '2: FLOCK  ADVISORY  WRITE 1234 00:19:555 0 EOF',
  '',
].join('\n')

const HEALTHY = [
  '1: POSIX  ADVISORY  READ 3490531 08:31:3760032966 1073741826 1073742335',
  '2: POSIX  ADVISORY  READ 3490531 08:31:3769403373 128 128',
  '2: -> POSIX  ADVISORY  WRITE 777 08:31:3769403373 128 128',
].join('\n')

describe('parseProcLocks / holdsDmsLock', () => {
  it('finds the DMS byte held by this pid on this inode', () => {
    expect(holdsDmsLock(parseProcLocks(HEALTHY), 3490531, '3769403373')).toBe(true)
  })

  it('the live hub on 2026-09-29: the database locked, the -shm not', () => {
    const locks = parseProcLocks(LIVE_LOST)
    expect(holdsDmsLock(locks, 3490531, '3769403373')).toBe(false)
    expect(locks.find((l) => l.pid === 1234)?.end).toBeNull()
  })

  it('a waiter (->) holds nothing, and another pid’s lock is not ours', () => {
    const waiterOnly = '1: -> POSIX  ADVISORY  WRITE 42 08:31:9 128 128\n'
    expect(holdsDmsLock(parseProcLocks(waiterOnly), 42, '9')).toBe(false)
    expect(holdsDmsLock(parseProcLocks(HEALTHY), 777, '3769403373')).toBe(false)
  })

  it('a range lock covering byte 128 counts; one that stops short does not', () => {
    const range = (s: number, e: string) => `1: POSIX ADVISORY READ 5 08:31:9 ${s} ${e}\n`
    expect(holdsDmsLock(parseProcLocks(range(120, '135')), 5, '9')).toBe(true)
    expect(holdsDmsLock(parseProcLocks(range(0, 'EOF')), 5, '9')).toBe(true)
    expect(holdsDmsLock(parseProcLocks(range(120, '127')), 5, '9')).toBe(false)
  })

  it('an inode beyond 2^53 is compared exactly, as text', () => {
    const big = '18446744073709551557'
    expect(
      holdsDmsLock(parseProcLocks(`1: POSIX ADVISORY READ 5 08:31:${big} 128 128\n`), 5, big),
    ).toBe(true)
    expect(
      holdsDmsLock(
        parseProcLocks(`1: POSIX ADVISORY READ 5 08:31:${big} 128 128\n`),
        5,
        '18446744073709551556',
      ),
    ).toBe(false)
  })

  it('the DMS byte is SQLite’s, stated once', () => {
    expect(SQLITE_SHM_DMS_BYTE).toBe(128)
  })
})

describe('ShmLockCanary transitions', () => {
  function canary(text: { value: string }, platform: NodeJS.Platform = 'linux') {
    const { logger, lines } = makeLogger()
    const deps: Partial<ShmLockCanaryDeps> = {
      platform,
      pid: 3490531,
      shmInode: () => '3769403373',
      readProcLocks: () => text.value,
    }
    return { c: new ShmLockCanary({ dbPath: '/x/camstack.db', logger, deps }), lines }
  }

  it('logs held once, a loss once at WARN, a recovery once — never a heartbeat', () => {
    const text = { value: HEALTHY }
    const { c, lines } = canary(text)
    expect(c.check()).toBe('held')
    expect(c.check()).toBe('held')
    text.value = LIVE_LOST
    expect(c.check()).toBe('missing')
    expect(c.check()).toBe('missing')
    text.value = HEALTHY
    expect(c.check()).toBe('held')
    expect(lines.map((l) => [l.level, l.message.split(' —')[0]])).toEqual([
      ['info', 'SQLite shm DMS lock held'],
      ['warn', 'SQLite shm DMS lock LOST'],
      ['info', 'SQLite shm DMS lock held'],
    ])
  })

  it('on Linux a failed look is a WARN naming the error, not "cannot look here"', () => {
    const { logger, lines } = makeLogger()
    const c = new ShmLockCanary({
      dbPath: '/x/camstack.db',
      logger,
      deps: {
        platform: 'linux',
        pid: 1,
        shmInode: () => {
          throw new Error('ENOENT: no such file')
        },
        readProcLocks: () => HEALTHY,
      },
    })
    expect(c.check()).toBe('unreadable')
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'SQLite shm DMS lock canary could not look',
      }),
    ])
    expect(lines[0]?.extras?.meta).toMatchObject({ error: 'ENOENT: no such file' })
  })

  it('off Linux it says once that it cannot look, and arms no timer', () => {
    const { c, lines } = canary({ value: HEALTHY }, 'darwin')
    c.start()
    c.stop()
    expect(lines.map((l) => l.message)).toEqual(['SQLite shm DMS lock canary cannot look here'])
  })
})

const onLinux = process.platform === 'linux'

describe.skipIf(!onLinux)('ShmLockCanary over the real kernel (Linux)', () => {
  const dirs: string[] = []
  const dbs: Database.Database[] = []
  afterEach(async () => {
    for (const db of dbs.splice(0)) db.close()
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
  })

  it('sees the lock a live WAL connection holds — and sees it vanish after one closeSync on the -shm', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shm-canary-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'camstack.db')
    const db = new Database(dbPath)
    dbs.push(db)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY)')
    db.prepare('INSERT INTO t DEFAULT VALUES').run()

    const { logger } = makeLogger()
    const c = new ShmLockCanary({ dbPath, logger })
    expect(c.check()).toBe('held')

    // What the retired worker did once a second (D679). This is the ONLY
    // place in the repository allowed to do it: it is the reproduction.
    const fd = openSync(`${dbPath}-shm`, 'r')
    readSync(fd, Buffer.alloc(100), 0, 100, 0)
    closeSync(fd)

    expect(c.check()).toBe('missing')
  })
})
