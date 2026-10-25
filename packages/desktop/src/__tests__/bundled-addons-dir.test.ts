/**
 * `resolveBundledAddonsDir` — the ONE tree the packaged app seeds addons from.
 *
 * Measured 2026-08-25 on `release/mac-arm64/camstack.app/Contents/Resources`:
 * the app shipped `node_modules/@camstack` (285 MB, 15 packages) AND a second
 * `addons/` tree (41 MB) holding 7 of those SAME packages, copied one by one by
 * `extraResources`. The second tree was not merely redundant, it was DEGRADED —
 * electron-builder dropped each package's own `node_modules`, so the very
 * natives `stage-deps.mjs` plants (and verifies) never reached the copy the
 * installer seeds from. This resolves the closure scope dir instead, so the
 * seed reads the copy that HAS them.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBundledAddonsDir } from '../process-manager'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-addons-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveBundledAddonsDir', () => {
  it('is the @camstack scope dir INSIDE the bundled closure, not a second tree', () => {
    const scope = path.join(tmp, 'node_modules', '@camstack')
    fs.mkdirSync(path.join(scope, 'addon-pipeline'), { recursive: true })
    expect(resolveBundledAddonsDir(tmp)).toBe(scope)
  })

  it('is null in dev — no packaged Resources path', () => {
    expect(resolveBundledAddonsDir(null)).toBeNull()
  })

  it('is null when the closure scope dir is absent, so the launcher falls back to npm', () => {
    expect(resolveBundledAddonsDir(tmp)).toBeNull()
  })

  it('never points at a file', () => {
    const nm = path.join(tmp, 'node_modules')
    fs.mkdirSync(nm, { recursive: true })
    fs.writeFileSync(path.join(nm, '@camstack'), 'not a dir')
    expect(resolveBundledAddonsDir(tmp)).toBeNull()
  })

  it('names the packages by their SHORT dir name — what AddonInstaller.findLocalPackage joins', () => {
    // `findLocalPackage('@camstack/addon-pipeline')` strips the scope and joins
    // `<workspaceDir>/addon-pipeline`. An npm scope dir is laid out exactly that
    // way, which is why it can replace the hand-copied `addons/` tree verbatim.
    const scope = path.join(tmp, 'node_modules', '@camstack')
    fs.mkdirSync(path.join(scope, 'addon-pipeline'), { recursive: true })
    fs.writeFileSync(
      path.join(scope, 'addon-pipeline', 'package.json'),
      JSON.stringify({ name: '@camstack/addon-pipeline', version: '1.0.0' }),
    )
    const resolved = resolveBundledAddonsDir(tmp)
    expect(resolved).not.toBeNull()
    if (resolved === null) return
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(resolved, 'addon-pipeline', 'package.json'), 'utf-8'),
    )
    expect(parsed).toMatchObject({ name: '@camstack/addon-pipeline' })
  })
})
