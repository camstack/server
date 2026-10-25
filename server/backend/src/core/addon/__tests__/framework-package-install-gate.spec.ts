import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTO_UPDATE_EXCLUDED_PACKAGES } from '../addon-package.service.js'

/**
 * The 2026-08-13 phantom-install incident: a manual "Update"/rollback of
 * `@camstack/server` (or system/types/sdk/kernel/core/ui-library) resolved to
 * category 'core' and ran a raw `npm install @camstack/server@X`, bypassing the
 * single-copy engine and saturating the host mid-`applyServerUpdate` publish.
 *
 * The auto-updater already skips these packages; the fix closed the MANUAL
 * paths. This is a SOURCE guard (the service constructor eagerly builds a real
 * installer, so a lightweight behavioural harness isn't cheap) asserting each
 * manual entry point still gates — a future edit that drops the gate fails here.
 */
const SOURCE = readFileSync(resolve(__dirname, '../addon-package.service.ts'), 'utf8')

/**
 * A generous window from a method's signature to the next `async` method
 * declaration. Brace-matching a body is fragile here — return types carry
 * object literals (`{ rolledBackTo: string | null }`) whose braces are not the
 * body — and the guard only needs the gate to appear before the next method.
 */
function methodBody(name: string): string {
  const start = SOURCE.indexOf(`async ${name}(`)
  expect(start, `method ${name} not found`).toBeGreaterThan(-1)
  const next = SOURCE.indexOf('\n  async ', start + 1)
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next)
}

describe('framework package install gate', () => {
  it('excludes @camstack/server and the framework tier from the addon-package path', () => {
    for (const name of [
      '@camstack/server',
      '@camstack/system',
      '@camstack/types',
      '@camstack/sdk',
      '@camstack/kernel',
      '@camstack/core',
      '@camstack/ui-library',
    ]) {
      expect(AUTO_UPDATE_EXCLUDED_PACKAGES.has(name), name).toBe(true)
    }
    // An addon is NOT excluded — the gate must not block a normal addon update.
    expect(AUTO_UPDATE_EXCLUDED_PACKAGES.has('@camstack/addon-pipeline')).toBe(false)
  })

  it('updatePackage refuses a framework package before installing', () => {
    expect(methodBody('updatePackage')).toContain('refuseExcludedFramework')
  })

  it('applyStagedAddonUpdate refuses a framework package before applying', () => {
    expect(methodBody('applyStagedAddonUpdate')).toContain('refuseExcludedFramework')
  })

  it('rollbackPackage refuses a framework package', () => {
    expect(methodBody('rollbackPackage')).toContain('AUTO_UPDATE_EXCLUDED_PACKAGES')
  })

  it('the refusal helper points the caller at applyServerUpdate', () => {
    const helper = SOURCE.slice(SOURCE.indexOf('private refuseExcludedFramework('))
    expect(helper).toContain('applyServerUpdate')
  })
})
