import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DATABASE_SNAPSHOT_PARTIAL_SUFFIX,
  DATABASE_SNAPSHOT_SUFFIX,
  type DatabaseSnapshotResult,
  type IScopedLogger,
  type LogExtras,
} from '@camstack/types'
import type Database from 'better-sqlite3'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { takeVerifiedCopy } from '../../sqlite-storage/sqlite-snapshot-worker.js'
import {
  BackupCancelledError,
  BackupSnapshotRefusedError,
  type DatabaseOwner,
  SystemBackupService,
} from '../system-backup.service.js'

const noopLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
  withTags: () => noopLogger,
}

/**
 * Extract a whole archive the way the boot-time restore does (`tar.extract`
 * minus the manifest) — the service has no restore of its own (D693).
 */
async function extractAll(archivePath: string, targetDir: string): Promise<void> {
  fs.mkdirSync(targetDir, { recursive: true })
  await tar.extract({
    file: archivePath,
    cwd: targetDir,
    filter: (p) => !p.endsWith('.camstack-backup-manifest.json'),
  })
}

/** Every path an archive carries, normalised (no `./`, no trailing `/`). */
async function archivePaths(archivePath: string): Promise<string[]> {
  const out: string[] = []
  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      out.push(entry.path.replace(/^\.\//, '').replace(/\/+$/, ''))
    },
  })
  return out
}

interface LiveDatabase {
  readonly live: Database.Database
  readonly dbPath: string
}

/** Frames the `PRAGMA wal_checkpoint` row reports in the WAL; narrowed, never cast. */
function walFramesOf(value: unknown): number {
  const row = Array.isArray(value) ? value[0] : value
  if (typeof row === 'object' && row !== null && 'log' in row && typeof row.log === 'number') {
    return row.log
  }
  throw new Error(`not a wal_checkpoint row: ${JSON.stringify(value)}`)
}

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

interface RecordingLogger {
  readonly logger: IScopedLogger
  readonly lines: LoggedLine[]
}

interface OpenLiveDatabase {
  readonly live: Database.Database
  readonly livePath: string
}

function recordingLogger(): RecordingLogger {
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

describe('SystemBackupService', () => {
  let tmpRoot: string
  let dataDir: string
  let service: SystemBackupService

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-sysbackup-'))
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.yaml'), 'cluster: prod\n')
    fs.mkdirSync(path.join(dataDir, 'addons', '@camstack', 'foo'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(dataDir, 'addons', '@camstack', 'foo', 'package.json'),
      JSON.stringify({ name: '@camstack/foo', version: '1.0.0' }),
    )
    service = new SystemBackupService(dataDir, noopLogger)
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe('createArchive', () => {
    it('produces a tar.gz of selected locations', async () => {
      const archivePath = path.join(tmpRoot, 'snap.tar.gz')
      const result = await service.createArchive({
        archivePath,
        locations: ['config.yaml', 'addons'],
      })
      expect(result.archivePath).toBe(archivePath)
      expect(result.includedLocations).toEqual(['config.yaml', 'addons'])
      expect(result.sizeBytes).toBeGreaterThan(0)
      expect(fs.existsSync(archivePath)).toBe(true)
    })

    it('skips missing locations and only includes what exists', async () => {
      const archivePath = path.join(tmpRoot, 'snap.tar.gz')
      const result = await service.createArchive({
        archivePath,
        locations: ['config.yaml', 'tls', 'does-not-exist'],
      })
      expect(result.includedLocations).toEqual(['config.yaml'])
    })

    it('throws when zero requested locations exist', async () => {
      const archivePath = path.join(tmpRoot, 'snap.tar.gz')
      await expect(
        service.createArchive({
          archivePath,
          locations: ['nope-1', 'nope-2'],
        }),
      ).rejects.toThrow(/no locations from/)
    })

    it('uses default location set when none provided', async () => {
      const archivePath = path.join(tmpRoot, 'snap.tar.gz')
      const result = await service.createArchive({ archivePath })
      // Defaults: config.yaml, db, addons, addons-data, tls, auto-update.json
      // Only the present ones get included.
      expect(result.includedLocations).toContain('config.yaml')
      expect(result.includedLocations).toContain('addons')
      expect(result.includedLocations).not.toContain('tls')
    })

    it('excludes its own staging dir when the archive is staged inside a backed-up location', async () => {
      // Reproduces the live "did not encounter expected EOF" bug: the
      // orchestrator stages the archive under
      // addons-data/backup-orchestrator/staging, which is inside the
      // `addons-data` location being tarred. tar must not read its own
      // growing output.
      const stagingDir = path.join(dataDir, 'addons-data', 'backup-orchestrator', 'staging')
      fs.mkdirSync(stagingDir, { recursive: true })
      fs.mkdirSync(path.join(dataDir, 'addons-data', 'other'), {
        recursive: true,
      })
      fs.writeFileSync(path.join(dataDir, 'addons-data', 'other', 'keep.txt'), 'keep')
      const archivePath = path.join(stagingDir, 'snap.tar.gz')

      const result = await service.createArchive({
        archivePath,
        locations: ['addons-data'],
      })
      expect(result.includedLocations).toEqual(['addons-data'])
      expect(fs.existsSync(archivePath)).toBe(true)

      const restoreDir = path.join(tmpRoot, 'restore-staging')
      await extractAll(archivePath, restoreDir)
      // Real content survives, the staging dir is excluded.
      expect(fs.existsSync(path.join(restoreDir, 'addons-data', 'other', 'keep.txt'))).toBe(true)
      expect(
        fs.existsSync(path.join(restoreDir, 'addons-data', 'backup-orchestrator', 'staging')),
      ).toBe(false)
    })
  })

  /**
   * D342 — a backup run must be stoppable IN FLIGHT. The 2026-09-04
   * incident left the operator with no way to stop two runaway builds
   * short of restarting the addon; these tests pin that `signal`
   * actually stops the tar stream (not just marks a row) and that the
   * half-written archive never survives the cancel.
   */
  describe('createArchive cancellation + progress', () => {
    /** Enough payload that the tar phase spans multiple stream chunks. */
    function seedBulk(): void {
      const bulkDir = path.join(dataDir, 'addons-data', 'bulk')
      fs.mkdirSync(bulkDir, { recursive: true })
      // Random bytes resist gzip so the compressed stream stays large
      // enough to flow through several transform chunks.
      for (let i = 0; i < 4; i++) {
        const chunk = Buffer.alloc(1024 * 1024)
        for (let b = 0; b < chunk.length; b += 4) chunk.writeUInt32LE((i * 7919 + b) >>> 0, b)
        fs.writeFileSync(path.join(bulkDir, `blob-${i}.bin`), chunk)
      }
    }

    it('aborting mid-tar stops the stream, deletes the half-written archive, and rejects BackupCancelledError', async () => {
      seedBulk()
      const archivePath = path.join(tmpRoot, 'staging', 'cancelled.tar.gz')
      const controller = new AbortController()
      await expect(
        service.createArchive({
          archivePath,
          locations: ['addons-data'],
          signal: controller.signal,
          // Cancel as soon as the first compressed bytes land — the
          // operator's stop button pressed while the archive grows.
          onArchiveBytes: () => controller.abort(),
        }),
      ).rejects.toBeInstanceOf(BackupCancelledError)
      // The partial archive is the build's own mess: it must be gone,
      // not left for a boot sweep to find months later.
      expect(fs.existsSync(archivePath)).toBe(false)
    })

    it('a signal aborted before the call refuses before walking anything', async () => {
      const archivePath = path.join(tmpRoot, 'staging', 'never.tar.gz')
      const controller = new AbortController()
      controller.abort()
      await expect(
        service.createArchive({ archivePath, signal: controller.signal }),
      ).rejects.toBeInstanceOf(BackupCancelledError)
      expect(fs.existsSync(archivePath)).toBe(false)
    })

    it('reports monotonically growing compressed bytes, ending at the on-disk size', async () => {
      seedBulk()
      const archivePath = path.join(tmpRoot, 'staging', 'watched.tar.gz')
      const seen: number[] = []
      const result = await service.createArchive({
        archivePath,
        locations: ['addons-data'],
        onArchiveBytes: (bytes) => seen.push(bytes),
      })
      expect(seen.length).toBeGreaterThan(1)
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!)
      }
      expect(seen[seen.length - 1]).toBe(result.sizeBytes)
      expect(fs.statSync(archivePath).size).toBe(result.sizeBytes)
    })
  })

  describe('backup exclusions', () => {
    /**
     * The live hub archived ~196 MB of per-addon `node_modules` on every
     * backup: `AddonInstaller` materialises runtime deps under
     * `addons/@camstack/<addon>/node_modules`, and the tar walk had no
     * filter for them. Only built `dist` (plus package.json/assets) is
     * restore-worthy — deps are reinstalled from npm.
     */
    it('never archives node_modules — dist and package.json survive, node_modules does not', async () => {
      const addonDir = path.join(dataDir, 'addons', '@camstack', 'foo')
      fs.mkdirSync(path.join(addonDir, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(addonDir, 'dist', 'index.js'), 'export {}')
      fs.mkdirSync(path.join(addonDir, 'node_modules', 'dep'), {
        recursive: true,
      })
      fs.writeFileSync(path.join(addonDir, 'node_modules', 'dep', 'big.js'), 'x'.repeat(4096))

      const archivePath = path.join(tmpRoot, 'snap.tar.gz')
      const result = await service.createArchive({
        archivePath,
        locations: ['addons'],
      })

      const restoreDir = path.join(tmpRoot, 'restored-nm')
      await extractAll(archivePath, restoreDir)
      expect(
        fs.existsSync(path.join(restoreDir, 'addons', '@camstack', 'foo', 'dist', 'index.js')),
      ).toBe(true)
      expect(
        fs.existsSync(path.join(restoreDir, 'addons', '@camstack', 'foo', 'package.json')),
      ).toBe(true)
      expect(
        fs.existsSync(path.join(restoreDir, 'addons', '@camstack', 'foo', 'node_modules')),
      ).toBe(false)
      // The embedded manifest must agree with the tar — no phantom entries.
      expect(result.manifest.entries.some((e) => e.path.includes('node_modules'))).toBe(false)
    })

    /**
     * The live hub swept 8.4 GB of operator-exported clips
     * (`addons-data/recorder/exports`) and the orchestrator's legacy
     * staging dir (`addons-data/backup-orchestrator/staging`, which held
     * previous backups) into every system backup. Neither is system
     * state.
     */
    it('excludes recorder exports and legacy orchestrator staging, keeps other addon state', async () => {
      const exportsDir = path.join(dataDir, 'addons-data', 'recorder', 'exports')
      fs.mkdirSync(exportsDir, { recursive: true })
      fs.writeFileSync(path.join(exportsDir, 'clip.mp4'), 'video-bytes')
      fs.writeFileSync(path.join(dataDir, 'addons-data', 'recorder', 'state.json'), '{}')
      const legacyStaging = path.join(dataDir, 'addons-data', 'backup-orchestrator', 'staging')
      fs.mkdirSync(legacyStaging, { recursive: true })
      fs.writeFileSync(path.join(legacyStaging, 'old-backup.tar.gz'), 'stale-archive')
      const sqliteDir = path.join(dataDir, 'addons-data', 'sqlite-settings')
      fs.mkdirSync(sqliteDir, { recursive: true })
      fs.writeFileSync(path.join(sqliteDir, 'camstack.db'), 'db')

      const archivePath = path.join(tmpRoot, 'snap2.tar.gz')
      const result = await service.createArchive({
        archivePath,
        locations: ['addons-data'],
      })

      const restoreDir = path.join(tmpRoot, 'restored-excl')
      await extractAll(archivePath, restoreDir)
      expect(
        fs.existsSync(path.join(restoreDir, 'addons-data', 'sqlite-settings', 'camstack.db')),
      ).toBe(true)
      expect(fs.existsSync(path.join(restoreDir, 'addons-data', 'recorder', 'state.json'))).toBe(
        true,
      )
      expect(fs.existsSync(path.join(restoreDir, 'addons-data', 'recorder', 'exports'))).toBe(false)
      expect(
        fs.existsSync(path.join(restoreDir, 'addons-data', 'backup-orchestrator', 'staging')),
      ).toBe(false)
      expect(
        result.manifest.entries.some((e) => e.path.startsWith('addons-data/recorder/exports')),
      ).toBe(false)
      expect(
        result.manifest.entries.some((e) =>
          e.path.startsWith('addons-data/backup-orchestrator/staging'),
        ),
      ).toBe(false)
    })
  })

  describe('restore marker', () => {
    it('writes, reads, and clears the pending marker', async () => {
      const archivePath = path.join(tmpRoot, 'snap.tar.gz')
      await service.createArchive({
        archivePath,
        locations: ['config.yaml'],
      })

      // Initially: no marker
      expect(service.readPendingMarker()).toBeNull()

      const markerPath = service.scheduleRestoreMarker({
        archivePath,
        source: 'test-id-123',
      })
      expect(fs.existsSync(markerPath)).toBe(true)

      const read = service.readPendingMarker()
      expect(read).not.toBeNull()
      expect(read?.archivePath).toBe(archivePath)
      expect(read?.source).toBe('test-id-123')

      service.clearPendingMarker()
      expect(service.readPendingMarker()).toBeNull()
    })

    it('refuses to schedule a marker pointing at a missing archive', () => {
      expect(() =>
        service.scheduleRestoreMarker({
          archivePath: path.join(tmpRoot, 'gone.tar.gz'),
          source: 'test',
        }),
      ).toThrow(/missing/)
    })

    it('returns null when marker file is malformed', () => {
      fs.writeFileSync(path.join(dataDir, '.pending-restore.json'), 'not json{')
      expect(service.readPendingMarker()).toBeNull()
    })
  })

  // A backup tars addon dirs whole while the hub is live. It must do so
  // WITHOUT a SQLite connection of its own: this service runs in hub-main,
  // and its open of the live settings database is what rebuilt the
  // runner's wal-index under it — SIGBUS after every 03:00 backup (D679).
  describe('live SQLite WAL database', () => {
    async function openLive(): Promise<LiveDatabase> {
      const Sqlite = (await import('better-sqlite3')).default
      const addonDataDir = path.join(dataDir, 'addons-data', 'sqlite-settings')
      fs.mkdirSync(addonDataDir, { recursive: true })
      const dbPath = path.join(addonDataDir, 'camstack.db')
      // The runner's shape: WAL, no auto-checkpoint, committed rows resident
      // in the -wal, the connection left open.
      const live = new Sqlite(dbPath)
      live.pragma('journal_mode = WAL')
      live.pragma('wal_autocheckpoint = 0')
      live.exec('CREATE TABLE device (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      const insert = live.prepare('INSERT INTO device (name) VALUES (?)')
      for (let i = 0; i < 200; i++) insert.run(`cam-${i}`)
      return { live, dbPath }
    }

    it('never opens it: no checkpoint lands on the file the owner is writing', async () => {
      const { live, dbPath } = await openLive()
      try {
        const dbBytesBefore = fs.statSync(dbPath).size
        // No owner here, so the archive refuses (next test) — after its walk
        // has stat'ed every file. The claim is what that walk did NOT do.
        await expect(
          service.createArchive({
            archivePath: path.join(tmpRoot, 'live.tar.gz'),
            locations: ['addons-data'],
          }),
        ).rejects.toBeInstanceOf(BackupSnapshotRefusedError)
        // Any connection that checkpoints — PASSIVE included — copies the
        // WAL's pages into the main file and grows it. Only the owner may.
        expect(fs.statSync(dbPath).size).toBe(dbBytesBefore)
        // And the owner still finds every frame un-backfilled: nobody else
        // folded them.
        expect(walFramesOf(live.pragma('wal_checkpoint(PASSIVE)'))).toBeGreaterThan(0)
        expect(fs.statSync(dbPath).size).toBeGreaterThan(dbBytesBefore)
      } finally {
        live.close()
      }
    })

    // A live database nobody owns STOPS the archive. Copied as files it is
    // torn (D679: 6/6 measured); left out, the archive's upload would prune an
    // older archive that has it — a worse backup pushing out a good one.
    it('builds NOTHING when a live database has no owner — and names it', async () => {
      const { live } = await openLive()
      const { logger, lines } = recordingLogger()
      const recording = new SystemBackupService(dataDir, logger)
      try {
        const archivePath = path.join(tmpRoot, 'live.tar.gz')
        await expect(
          recording.createArchive({
            archivePath,
            locations: ['addons-data'],
            owner: {
              listDatabases: async () => [],
              writeSnapshot: async () => {
                throw new Error('must not be asked')
              },
            },
          }),
        ).rejects.toThrow(/addons-data\/sqlite-settings\/camstack\.db has no owner/)
        expect(fs.existsSync(archivePath)).toBe(false)
        expect(
          lines.some((l) => l.level === 'error' && l.message.includes('no owner snapshot')),
        ).toBe(true)
      } finally {
        live.close()
      }
    })
  })

  describe('owner snapshots (D693)', () => {
    const LIVE_REL = 'addons-data/sqlite-settings/camstack.db'

    async function openLiveDatabase(): Promise<OpenLiveDatabase> {
      const Sqlite = (await import('better-sqlite3')).default
      const addonDataDir = path.join(dataDir, 'addons-data', 'sqlite-settings')
      fs.mkdirSync(addonDataDir, { recursive: true })
      const livePath = path.join(addonDataDir, 'camstack.db')
      const live = new Sqlite(livePath)
      live.pragma('journal_mode = WAL')
      live.pragma('wal_autocheckpoint = 0')
      live.exec('CREATE TABLE device (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      const insert = live.prepare('INSERT INTO device (name) VALUES (?)')
      for (let i = 0; i < 200; i++) insert.run(`cam-${i}`)
      return { live, livePath }
    }

    /** An owner that declares `livePath` and answers `writeSnapshot` with `write`. */
    function ownerOf(
      livePath: string,
      write: () => Promise<DatabaseSnapshotResult>,
    ): DatabaseOwner {
      return {
        listDatabases: async () => [{ databaseId: 'settings', livePath }],
        writeSnapshot: async () => ({ ...(await write()), databaseId: 'settings' }),
      }
    }

    /** The owner's side, as the snapshot worker + snapshotter write it. */
    async function ownerSnapshotOf(livePath: string): Promise<DatabaseSnapshotResult> {
      const workDir = livePath + DATABASE_SNAPSHOT_PARTIAL_SUFFIX
      fs.mkdirSync(workDir)
      const copy = await takeVerifiedCopy({
        kind: 'sqlite-snapshot',
        livePath,
        copyPath: path.join(workDir, 'copy'),
        pagesPerStep: 64,
      })
      const snapshotPath = livePath + DATABASE_SNAPSHOT_SUFFIX
      fs.renameSync(path.join(workDir, 'copy'), snapshotPath)
      fs.rmSync(workDir, { recursive: true })
      return {
        livePath,
        snapshotPath,
        sizeBytes: fs.statSync(snapshotPath).size,
        pageCount: copy.pageCount,
        pageSize: copy.pageSize,
        tables: [...copy.tables],
        copyMs: copy.copyMs,
        verifyMs: copy.verifyMs,
        takenAt: copy.takenAt,
      }
    }

    it('carries the owner snapshot in place of the live .db, -wal and -shm, records it, then deletes it', async () => {
      const { live, livePath } = await openLiveDatabase()
      try {
        let asked = 0
        const taken: DatabaseSnapshotResult[] = []
        const archivePath = path.join(tmpRoot, 'owner.tar.gz')
        const result = await service.createArchive({
          archivePath,
          locations: ['addons-data'],
          owner: ownerOf(livePath, async () => {
            asked++
            const snapshot = await ownerSnapshotOf(livePath)
            taken.push(snapshot)
            // A write AFTER the snapshot: the archive must not see it anywhere.
            live.prepare('INSERT INTO device (name) VALUES (?)').run('late')
            return snapshot
          }),
        })
        expect(asked).toBe(1)
        const carried = await archivePaths(archivePath)
        expect(carried).toContain(LIVE_REL + DATABASE_SNAPSHOT_SUFFIX)
        for (const suffix of ['', '-wal', '-shm']) {
          expect(carried).not.toContain(LIVE_REL + suffix)
          expect(result.manifest.entries.some((e) => e.path === LIVE_REL + suffix)).toBe(false)
        }
        expect(
          result.manifest.entries.some((e) => e.path === LIVE_REL + DATABASE_SNAPSHOT_SUFFIX),
        ).toBe(true)
        const snapshot = taken[0]
        if (snapshot === undefined) throw new Error('the owner was never asked')
        expect(result.manifest.sqliteSnapshots).toEqual([
          {
            ...snapshot,
            databaseId: 'settings',
            livePath: LIVE_REL,
            snapshotPath: LIVE_REL + DATABASE_SNAPSHOT_SUFFIX,
          },
        ])
        // Layout-neutral: with only camstack.db owned, nothing is "omitted".
        expect(result.manifest.omittedDatabases).toBeUndefined()
        // The snapshot existed for this archive only.
        expect(fs.existsSync(livePath + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)

        // The carried copy is the snapshot's instant: intact, 200 rows.
        const restoreDir = path.join(tmpRoot, 'owner-restored')
        await extractAll(archivePath, restoreDir)
        const Sqlite = (await import('better-sqlite3')).default
        const restored = new Sqlite(path.join(restoreDir, LIVE_REL + DATABASE_SNAPSHOT_SUFFIX), {
          readonly: true,
        })
        try {
          expect(restored.pragma('integrity_check', { simple: true })).toBe('ok')
          expect(restored.prepare('SELECT COUNT(*) AS n FROM device').get()).toEqual({ n: 200 })
        } finally {
          restored.close()
        }
      } finally {
        live.close()
      }
    })

    it('builds NOTHING when the owner cannot produce its snapshot', async () => {
      const { live, livePath } = await openLiveDatabase()
      try {
        const archivePath = path.join(tmpRoot, 'refused.tar.gz')
        // The owner's thread finished after the caller gave up: its snapshot
        // landed, and nobody will collect it.
        const orphan = livePath + DATABASE_SNAPSHOT_SUFFIX
        const run = service.createArchive({
          archivePath,
          locations: ['addons-data'],
          owner: ownerOf(livePath, async () => {
            fs.writeFileSync(orphan, 'late copy')
            throw new Error('database snapshot refused (integrity): *** in database main ***')
          }),
        })
        await expect(run).rejects.toBeInstanceOf(BackupSnapshotRefusedError)
        await expect(run).rejects.toThrow(/integrity/)
        expect(fs.existsSync(archivePath)).toBe(false)
        expect(fs.existsSync(orphan)).toBe(false)
      } finally {
        live.close()
      }
    })

    it('a run cancelled while the owner copied stops there and deletes the copy', async () => {
      const { live, livePath } = await openLiveDatabase()
      try {
        const controller = new AbortController()
        const archivePath = path.join(tmpRoot, 'cancelled.tar.gz')
        await expect(
          service.createArchive({
            archivePath,
            locations: ['addons-data'],
            signal: controller.signal,
            owner: ownerOf(livePath, async () => {
              const snapshot = await ownerSnapshotOf(livePath)
              controller.abort()
              return snapshot
            }),
          }),
        ).rejects.toBeInstanceOf(BackupCancelledError)
        expect(fs.existsSync(archivePath)).toBe(false)
        // Removed once the abandoned call settles — moments after the rejection.
        await expect.poll(() => fs.existsSync(livePath + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
      } finally {
        live.close()
      }
    })

    it('never asks the owner when no SQLite file is under the requested locations', async () => {
      const { live } = await openLiveDatabase()
      try {
        let asked = 0
        await service.createArchive({
          archivePath: path.join(tmpRoot, 'cfg.tar.gz'),
          locations: ['config.yaml', 'addons'],
          owner: {
            listDatabases: async () => {
              asked++
              return []
            },
            writeSnapshot: async () => {
              asked++
              throw new Error('must not be asked')
            },
          },
        })
        expect(asked).toBe(0)
      } finally {
        live.close()
      }
    })

    it('snapshots an owned database even when it was closed cleanly — no sidecar, still owned', async () => {
      const { live, livePath } = await openLiveDatabase()
      live.close()
      expect(fs.existsSync(`${livePath}-wal`)).toBe(false)
      let asked = 0
      const archivePath = path.join(tmpRoot, 'closed.tar.gz')
      const result = await service.createArchive({
        archivePath,
        locations: ['addons-data'],
        owner: ownerOf(livePath, async () => {
          asked++
          return ownerSnapshotOf(livePath)
        }),
      })
      expect(asked).toBe(1)
      const carried = await archivePaths(archivePath)
      expect(carried).toContain(LIVE_REL + DATABASE_SNAPSHOT_SUFFIX)
      expect(carried).not.toContain(LIVE_REL)
      expect(result.manifest.sqliteSnapshots?.[0]?.livePath).toBe(LIVE_REL)
    })

    it('never archives the -journal of an owned database', async () => {
      const { live, livePath } = await openLiveDatabase()
      try {
        // A rollback journal beside the database (empty, so not hot: the
        // owner's copy still opens it). It belongs to the live file.
        fs.writeFileSync(`${livePath}-journal`, '')
        const archivePath = path.join(tmpRoot, 'journal.tar.gz')
        const result = await service.createArchive({
          archivePath,
          locations: ['addons-data'],
          owner: ownerOf(livePath, async () => ownerSnapshotOf(livePath)),
        })
        expect(await archivePaths(archivePath)).not.toContain(`${LIVE_REL}-journal`)
        expect(result.manifest.entries.some((e) => e.path === `${LIVE_REL}-journal`)).toBe(false)
      } finally {
        live.close()
      }
    })

    it('builds NOTHING when the owner cannot say what it owns', async () => {
      const { live } = await openLiveDatabase()
      try {
        await expect(
          service.createArchive({
            archivePath: path.join(tmpRoot, 'unasked.tar.gz'),
            locations: ['addons-data'],
            owner: {
              listDatabases: async () => {
                throw new Error('runner restarting')
              },
              writeSnapshot: async () => {
                throw new Error('must not be asked')
              },
            },
          }),
        ).rejects.toThrow(/owner could not be asked: runner restarting/)
      } finally {
        live.close()
      }
    })

    it('refuses a snapshot that is not on this data root — and does NOT delete a file it was only told about', async () => {
      const { live, livePath } = await openLiveDatabase()
      try {
        const elsewhereDir = path.join(tmpRoot, 'elsewhere')
        fs.mkdirSync(elsewhereDir)
        const elsewhere = path.join(elsewhereDir, 'camstack.db')
        fs.writeFileSync(elsewhere + DATABASE_SNAPSHOT_SUFFIX, 'copy')
        await expect(
          service.createArchive({
            archivePath: path.join(tmpRoot, 'x.tar.gz'),
            locations: ['addons-data'],
            owner: ownerOf(livePath, async () => ({
              ...(await ownerSnapshotOf(livePath)),
              livePath: elsewhere,
              snapshotPath: elsewhere + DATABASE_SNAPSHOT_SUFFIX,
            })),
          }),
        ).rejects.toThrow(/not under this archive's data root/)
        // A path another process named is never deleted on its word; the
        // owner's sweep handles what it wrote.
        expect(fs.existsSync(elsewhere + DATABASE_SNAPSHOT_SUFFIX)).toBe(true)
        // The snapshot it really wrote, beside the owned database, is removed.
        expect(fs.existsSync(livePath + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
      } finally {
        live.close()
      }
    })

    it('an owner answering its LIVE database as the snapshot is refused — and the live file is untouched', async () => {
      const { live, livePath } = await openLiveDatabase()
      try {
        await expect(
          service.createArchive({
            archivePath: path.join(tmpRoot, 'self.tar.gz'),
            locations: ['addons-data'],
            owner: ownerOf(livePath, async () => ({
              ...(await ownerSnapshotOf(livePath)),
              snapshotPath: livePath,
            })),
          }),
        ).rejects.toThrow(/does not sit beside the database/)
        expect(fs.existsSync(livePath)).toBe(true)
        expect(live.prepare('SELECT COUNT(*) AS n FROM device').get()).toEqual({ n: 200 })
      } finally {
        live.close()
      }
    })

    it('a file that merely ends in -journal is not a live database — the archive builds', async () => {
      const dir = path.join(dataDir, 'addons-data', 'other')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'build-journal'), 'not sqlite')
      fs.writeFileSync(path.join(dir, 'notes.txt-wal'), 'not sqlite either')
      const archivePath = path.join(tmpRoot, 'journal-name.tar.gz')
      await service.createArchive({ archivePath, locations: ['addons-data'] })
      expect(await archivePaths(archivePath)).toContain('addons-data/other/build-journal')
    })

    it('a cancel lands while the owner is still copying — and its late copy is removed', async () => {
      const { live, livePath } = await openLiveDatabase()
      try {
        const controller = new AbortController()
        let finishCopy: () => void = () => undefined
        const landed: boolean[] = []
        const copyDone = new Promise<void>((resolve) => {
          finishCopy = resolve
        })
        const run = service.createArchive({
          archivePath: path.join(tmpRoot, 'slow.tar.gz'),
          locations: ['addons-data'],
          signal: controller.signal,
          owner: ownerOf(livePath, async () => {
            controller.abort()
            await copyDone
            const late = await ownerSnapshotOf(livePath)
            landed.push(fs.existsSync(late.snapshotPath))
            return late
          }),
        })
        // Rejected while the owner is still copying — not after it.
        await expect(run).rejects.toBeInstanceOf(BackupCancelledError)
        expect(landed).toEqual([])
        finishCopy()
        // The copy the owner finished afterwards landed, and is removed.
        await expect.poll(() => landed).toEqual([true])
        await expect.poll(() => fs.existsSync(livePath + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
      } finally {
        live.close()
      }
    })

    it('never archives a snapshot or a work directory it did not ask for', async () => {
      const sqliteDir = path.join(dataDir, 'addons-data', 'sqlite-settings')
      fs.mkdirSync(path.join(sqliteDir, `camstack.db${DATABASE_SNAPSHOT_PARTIAL_SUFFIX}`), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(sqliteDir, `camstack.db${DATABASE_SNAPSHOT_PARTIAL_SUFFIX}`, 'copy'),
        'half',
      )
      fs.writeFileSync(path.join(sqliteDir, `camstack.db${DATABASE_SNAPSHOT_SUFFIX}`), 'stale')
      fs.writeFileSync(path.join(sqliteDir, 'keep.json'), '{}')
      const archivePath = path.join(tmpRoot, 'stale.tar.gz')
      const result = await service.createArchive({ archivePath, locations: ['addons-data'] })
      const carried = await archivePaths(archivePath)
      expect(carried).toContain('addons-data/sqlite-settings/keep.json')
      expect(carried.some((p) => p.includes('.backup-snapshot'))).toBe(false)
      expect(result.manifest.entries.some((e) => e.path.includes('.backup-snapshot'))).toBe(false)
    })
  })
})
