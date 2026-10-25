/**
 * device-history is a system builtin (D850): hub-only, own runner, not co-located
 * with sqlite-settings (D29).
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { type AddonDeclaration, isIsolatedBuiltin, resolveRunnerId } from '@camstack/types'
import { describe, expect, it } from 'vitest'

const pkgPath = path.resolve(import.meta.dirname, '../../../../package.json')

function deviceHistoryManifest(): AddonDeclaration {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    readonly camstack: { readonly addons: readonly AddonDeclaration[] }
  }
  const entry = pkg.camstack.addons.find((a) => a.id === 'device-history')
  if (entry === undefined) throw new Error('device-history missing from camstack.addons')
  return entry
}

describe('device-history system manifest', () => {
  it('is hub-only, isolated, and owns device-history (not grouped with sqlite-settings)', () => {
    const entry = deviceHistoryManifest()
    expect(entry['protected']).toBe(true)
    expect(entry.execution?.placement).toBe('hub-only')
    expect(isIsolatedBuiltin(entry)).toBe(true)
    expect(resolveRunnerId(entry, entry.id)).toBe('device-history')
    expect(entry.entry).toBe('./dist/builtins/device-history/device-history.addon.js')
    const capNames = (entry.capabilities ?? []).map((c) => c.name)
    expect(capNames).toContain('device-history')
    expect(capNames).toContain('device-removal-hook')
  })
})
