import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Nx 23 stores task metadata in `.nx/workspace-data/<machine-id>-v3.db`.
 * A GitHub-hosted runner has a new machine id every job, so a restored
 * database is invisible until it is copied onto this machine's id.
 */
const script = join(import.meta.dirname, '../ci/align-nx-db.sh')

function run(root: string, machineId: string): void {
  execFileSync('bash', [script], {
    cwd: root,
    env: { ...process.env, CAMSTACK_NX_MACHINE_ID: machineId },
    stdio: 'pipe',
  })
}

describe('align-nx-db', () => {
  it('copies a restored database onto this machine id, wal included', () => {
    const root = mkdtempSync(join(tmpdir(), 'align-nx-'))
    try {
      const data = join(root, '.nx', 'workspace-data')
      mkdirSync(data, { recursive: true })
      writeFileSync(join(data, 'OLD-MACHINE-v3.db'), 'records')
      writeFileSync(join(data, 'OLD-MACHINE-v3.db-wal'), 'wal')
      run(root, 'this-machine')
      expect(readFileSync(join(data, 'this-machine-v3.db'), 'utf8')).toBe('records')
      expect(readFileSync(join(data, 'this-machine-v3.db-wal'), 'utf8')).toBe('wal')
      expect(readFileSync(join(data, 'OLD-MACHINE-v3.db'), 'utf8')).toBe('records')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not overwrite a database that already belongs to this machine', () => {
    const root = mkdtempSync(join(tmpdir(), 'align-nx-'))
    try {
      const data = join(root, '.nx', 'workspace-data')
      mkdirSync(data, { recursive: true })
      writeFileSync(join(data, 'this-machine-v3.db'), 'local')
      writeFileSync(join(data, 'OLD-MACHINE-v3.db'), 'restored')
      run(root, 'this-machine')
      expect(readFileSync(join(data, 'this-machine-v3.db'), 'utf8')).toBe('local')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exits cleanly when the cache directory is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'align-nx-'))
    try {
      expect(() => run(root, 'this-machine')).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
