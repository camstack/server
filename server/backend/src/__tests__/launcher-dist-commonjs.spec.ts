/**
 * The Docker starter loads `dist/launcher.js` with `require()`. A publish that
 * emits ESM (bare `import` at the top, no `"use strict"`) crashloops on
 * applyServerUpdate — see tsconfig.build.json must override the dev ES2022 module.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const BACKEND_ROOT = path.resolve(__dirname, '..', '..')
const LAUNCHER_DIST = path.join(BACKEND_ROOT, 'dist', 'launcher.js')

function ensureBackendBuilt(): void {
  const tsconfigPath = path.join(BACKEND_ROOT, 'tsconfig.build.json')
  const launcherStat = fs.statSync(LAUNCHER_DIST, { throwIfNoEntry: false })
  const tsconfigStat = fs.statSync(tsconfigPath, { throwIfNoEntry: false })
  if (
    launcherStat !== undefined &&
    tsconfigStat !== undefined &&
    launcherStat.mtimeMs > tsconfigStat.mtimeMs
  ) {
    return
  }
  execFileSync('npm', ['run', 'build'], { cwd: BACKEND_ROOT, stdio: 'inherit' })
}

describe('dist/launcher.js — CommonJS for require() entrypoints', () => {
  it('is emitted as CommonJS (use strict + require, not ESM import)', () => {
    ensureBackendBuilt()
    const source = fs.readFileSync(LAUNCHER_DIST, 'utf-8')
    const head = source.slice(0, 200)

    expect(head, 'launcher must open with "use strict" for CJS emit').toContain('"use strict"')
    expect(head, 'launcher must not start with ESM import').not.toMatch(/^\s*import\s/m)
    expect(source, 'launcher must use require() bindings').toMatch(/\brequire\s*\(/)
  })
})
