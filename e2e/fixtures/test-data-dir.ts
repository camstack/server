/**
 * Per-suite isolated data directory.
 *
 * Each suite calls `createTestDataDir()` which mktemp's a fresh directory
 * under `/tmp/camstack-e2e-XXXX`. The hub fixture passes this as
 * `CAMSTACK_DATA` so the spawned process has zero contamination from any
 * operator hub running on the dev machine.
 *
 * Cleanup is deferred to the caller (typically `afterAll`) — the directory
 * lives long enough for failure investigation.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface TestDataDir {
  readonly path: string
  cleanup(): void
}

export function createTestDataDir(prefix = 'camstack-e2e-'): TestDataDir {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    path: dataDir,
    cleanup() {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // Best-effort — don't fail teardown on cleanup glitches.
      }
    },
  }
}

/**
 * Sniff the latest log file written by the hub. Useful for asserting on
 * boot-time AddonLoader warnings (regression for Fix #9 — silent loader
 * failures) without rebuilding the structured-log pipeline.
 */
export function readLatestLogFile(dataDir: string): string {
  const logsDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logsDir)) return ''
  const entries = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (entries.length === 0) return ''
  return fs.readFileSync(path.join(logsDir, entries[0]!.name), 'utf-8')
}
