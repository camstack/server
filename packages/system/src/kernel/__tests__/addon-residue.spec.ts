/**
 * Residue quarantine — the `.bak` directory is INSTALLED, not archived.
 *
 * Every one of these cases was measured on the live cluster on 2026-08-07/08.
 * The directory name is decoration: three independent consumers key on the
 * `package.json` inside it, so renaming `@camstack/system` to
 * `system.bak-pre-1272-…` left it loaded, scanned and REPORTED.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  QUARANTINE_DIRNAME,
  classifyAddonDir,
  quarantineAddonResidue,
  selectAddonResidue,
} from '../addon-residue.js'

describe('classifyAddonDir', () => {
  it('flags the live agent-a residue — a `.bak` with no package.json at all', () => {
    // `system.bak-pre-unshadow` held only node_modules/better-sqlite3/build.
    // Not loadable, but the agent main process held five live mappings of the
    // native module out of it.
    expect(classifyAddonDir({ dirName: 'system.bak-pre-unshadow', declaredName: null })).toEqual({
      dirName: 'system.bak-pre-unshadow',
      reason: 'backup-residue',
      declaredName: null,
    })
  })

  it('flags the live macmini residue — a `.bak` that still declares @camstack/system', () => {
    expect(
      classifyAddonDir({
        dirName: 'system.bak-pre-1272-1786129145',
        declaredName: '@camstack/system',
      }),
    ).toEqual({
      dirName: 'system.bak-pre-1272-1786129145',
      reason: 'backup-residue',
      declaredName: '@camstack/system',
    })
  })

  it('flags a renamed directory even when the new name looks nothing like a backup', () => {
    expect(
      classifyAddonDir({ dirName: 'system-disabled', declaredName: '@camstack/system' }),
    ).toEqual({
      dirName: 'system-disabled',
      reason: 'name-mismatch',
      declaredName: '@camstack/system',
    })
  })

  it('keeps a package whose directory matches its declared name', () => {
    expect(classifyAddonDir({ dirName: 'system', declaredName: '@camstack/system' })).toBeNull()
    expect(
      classifyAddonDir({ dirName: 'addon-pipeline', declaredName: '@camstack/addon-pipeline' }),
    ).toBeNull()
  })

  it('never touches the installer-owned dot directories', () => {
    // `.backups` textually contains ".bak" — the dot rule has to win, or the
    // sweep's own rollback store becomes residue.
    for (const dirName of ['.backups', '.staging', '.evicting', '.npm-bootstrap', '.quarantine']) {
      expect(classifyAddonDir({ dirName, declaredName: null })).toBeNull()
    }
    expect(classifyAddonDir({ dirName: 'node_modules', declaredName: null })).toBeNull()
  })

  it('leaves a plain directory with no package.json alone — absence is not residue', () => {
    expect(classifyAddonDir({ dirName: 'models', declaredName: null })).toBeNull()
  })

  it('selects only the residue out of a mixed listing', () => {
    expect(
      selectAddonResidue([
        { dirName: 'addon-pipeline', declaredName: '@camstack/addon-pipeline' },
        { dirName: 'system.bak-pre-unshadow', declaredName: null },
        { dirName: 'system', declaredName: '@camstack/system' },
        { dirName: '.staging', declaredName: null },
      ]).map((v) => v.dirName),
    ).toEqual(['system.bak-pre-unshadow'])
  })
})

describe('quarantineAddonResidue', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-residue-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writePkg(dir: string, name: string, version: string): void {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
  }

  it('moves residue out of the scanned root, keeps the real package, and never deletes', () => {
    const scope = path.join(root, '@camstack')
    writePkg(path.join(scope, 'system'), '@camstack/system', '1.2.61')
    writePkg(path.join(scope, 'system.bak-pre-1272-1786129145'), '@camstack/system', '1.2.3')

    const lines: string[] = []
    const result = quarantineAddonResidue(root, (m) => lines.push(m))

    expect(result.quarantined).toHaveLength(1)
    expect(fs.existsSync(path.join(scope, 'system.bak-pre-1272-1786129145'))).toBe(false)
    expect(fs.existsSync(path.join(scope, 'system', 'package.json'))).toBe(true)

    // Moved, not removed — the bytes are still on disk under quarantine.
    const moved = result.quarantined[0]!.to
    expect(moved.startsWith(path.join(root, QUARANTINE_DIRNAME))).toBe(true)
    expect(fs.existsSync(path.join(moved, 'package.json'))).toBe(true)

    // A silent quarantine reads as "nothing happened" — every move is named.
    expect(lines.join('\n')).toContain('system.bak-pre-1272-1786129145')
    expect(lines.join('\n')).toContain('@camstack/system')
  })

  it('the quarantine store is not itself an addon root', () => {
    const scope = path.join(root, '@camstack')
    writePkg(path.join(scope, 'system.bak-old'), '@camstack/system', '1.2.3')
    quarantineAddonResidue(root, () => {})

    // Second pass sees nothing to do: the store is skipped, not re-scanned.
    const second = quarantineAddonResidue(root, () => {})
    expect(second.quarantined).toEqual([])
  })

  it('does not collide when the same residue name is quarantined twice', () => {
    const scope = path.join(root, '@camstack')
    writePkg(path.join(scope, 'system.bak-old'), '@camstack/system', '1.2.3')
    const first = quarantineAddonResidue(root, () => {})
    writePkg(path.join(scope, 'system.bak-old'), '@camstack/system', '1.2.4')
    const second = quarantineAddonResidue(root, () => {})

    expect(first.quarantined[0]!.to).not.toEqual(second.quarantined[0]!.to)
    expect(fs.existsSync(path.join(first.quarantined[0]!.to, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(second.quarantined[0]!.to, 'package.json'))).toBe(true)
  })

  it('is a no-op on a clean root', () => {
    writePkg(path.join(root, '@camstack', 'addon-pipeline'), '@camstack/addon-pipeline', '1.2.46')
    const lines: string[] = []
    expect(quarantineAddonResidue(root, (m) => lines.push(m)).quarantined).toEqual([])
    expect(lines).toEqual([])
  })

  it('tolerates a missing addons dir', () => {
    expect(quarantineAddonResidue(path.join(root, 'nope'), () => {}).quarantined).toEqual([])
  })
})
