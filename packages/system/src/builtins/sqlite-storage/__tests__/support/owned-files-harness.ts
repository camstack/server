/**
 * Shared scaffolding for the owned-file specs (D851): a recording logger, a
 * temp directory, the real engine opened the way the addon opens it — settings
 * in place, events and history on REAL worker threads loaded from the
 * TypeScript source through tsx — and a lifecycle that counts instead of
 * arming real checkpointers.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DataStoreDatabase, IScopedLogger, LogExtras } from '@camstack/types'
import { RUNTIME_DEFAULTS } from '@camstack/types'
import type { FileLifecycle, OwnedFileDeps, OwnedSqliteFile } from '../../owned-sqlite-file.js'
import { openOwnedSqliteFile } from '../../owned-sqlite-file.js'
import type { OwnedSqliteFileSpec } from '../../file-host-protocol.js'
import { PlacementRouter } from '../../placement-router.js'

export interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly scope: string
  readonly message: string
  readonly extras?: LogExtras
}

export function recordingLogger(
  lines: LoggedLine[],
  scope = '',
  bound: LogExtras['tags'] = {},
): IScopedLogger {
  const push =
    (level: LoggedLine['level']) =>
    (message: string, extras?: LogExtras): void => {
      const tags = { ...bound, ...extras?.tags }
      lines.push({ level, scope, message, extras: { ...extras, tags } })
    }
  return {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: (childScope) => recordingLogger(lines, childScope, bound),
    withTags: (tags) => recordingLogger(lines, scope, { ...bound, ...tags }),
  }
}

const WORKER_SOURCE = fileURLToPath(new URL('../../file-host-worker.ts', import.meta.url))

export const FILE_NAMES: Readonly<Record<DataStoreDatabase, string>> = {
  settings: 'camstack.db',
  events: 'events.db',
  history: 'history.db',
}

/** What a counting lifecycle saw, per database file. */
export interface LifecycleLedger {
  readonly started: string[]
  readonly stopped: string[]
}

export interface Harness {
  readonly dir: string
  readonly lines: LoggedLine[]
  readonly fatal: string[]
  readonly ledger: LifecycleLedger
  readonly deps: OwnedFileDeps
  pathOf(databaseId: DataStoreDatabase): string
  specOf(
    databaseId: DataStoreDatabase,
    overrides?: Partial<OwnedSqliteFileSpec>,
  ): OwnedSqliteFileSpec
  /** Settings in place + a router that creates worker files lazily. */
  router(existing?: readonly DataStoreDatabase[]): Promise<PlacementRouter>
  stopAll(router: PlacementRouter): Promise<void>
  cleanup(): void
}

export function makeHarness(overrides: Partial<OwnedFileDeps> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'camstack-owned-files-'))
  const lines: LoggedLine[] = []
  const fatal: string[] = []
  const ledger: LifecycleLedger = { started: [], stopped: [] }
  const countingLifecycle = (spec: OwnedSqliteFileSpec): FileLifecycle => ({
    checkpointer: {
      start: () => ledger.started.push(`checkpointer:${spec.databaseId}`),
      stop: async () => {
        ledger.stopped.push(`checkpointer:${spec.databaseId}`)
      },
    },
    canary: {
      start: () => ledger.started.push(`canary:${spec.databaseId}`),
      stop: () => ledger.stopped.push(`canary:${spec.databaseId}`),
    },
    snapshotter: {
      sweep: async () => {
        ledger.started.push(`snapshotter:${spec.databaseId}`)
      },
      write: async () => {
        throw new Error('the harness does not take snapshots')
      },
    },
  })
  const deps: OwnedFileDeps = {
    logger: recordingLogger(lines),
    onFatal: (reason) => fatal.push(reason),
    runtimeDefaults: { ...RUNTIME_DEFAULTS },
    workerPath: WORKER_SOURCE,
    workerExecArgv: ['--import', 'tsx'],
    lifecycle: countingLifecycle,
    ...overrides,
  }
  const pathOf = (databaseId: DataStoreDatabase): string => join(dir, FILE_NAMES[databaseId])
  const specOf = (
    databaseId: DataStoreDatabase,
    spec: Partial<OwnedSqliteFileSpec> = {},
  ): OwnedSqliteFileSpec => ({
    databaseId,
    livePath: pathOf(databaseId),
    thread: databaseId === 'settings' ? 'main' : 'worker',
    autoVacuum: databaseId === 'settings' ? 'none' : 'incremental',
    loadVectorExtension: databaseId === 'events',
    ...spec,
  })
  const harness: Harness = {
    dir,
    lines,
    fatal,
    ledger,
    deps,
    pathOf,
    specOf,
    async router(existing = []) {
      const settings = await openOwnedSqliteFile(specOf('settings'), deps)
      const open = (databaseId: DataStoreDatabase): Promise<OwnedSqliteFile> =>
        openOwnedSqliteFile(specOf(databaseId), deps)
      const files: OwnedSqliteFile[] = [settings]
      for (const databaseId of existing) files.push(await open(databaseId))
      try {
        return new PlacementRouter({ files, open, logger: recordingLogger(lines, 'Placement') })
      } catch (err) {
        // A refused layout must not leak the connections it opened.
        for (const file of files.toReversed()) await file.stop()
        throw err
      }
    },
    async stopAll(router) {
      for (const file of router.openFiles().toReversed()) await file.stop()
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return harness
}

/** A declaration for a small ledger table in the named file. */
export function ledgerDeclaration(
  collection: string,
  database?: DataStoreDatabase,
): {
  collection: string
  columns: readonly { name: string; type: 'TEXT' | 'INTEGER'; primaryKey?: boolean }[]
  database?: DataStoreDatabase
} {
  return {
    collection,
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true },
      { name: 'atMs', type: 'INTEGER' },
      { name: 'label', type: 'TEXT' },
    ],
    ...(database !== undefined ? { database } : {}),
  }
}
