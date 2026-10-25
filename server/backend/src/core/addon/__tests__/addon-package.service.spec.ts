import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SYSTEM_PACKAGE, isFrameworkPackage } from '../addon-package.service.js'

// Monorepo root: server/backend/src/../../../.. = worktree root
const MONOREPO_ROOT = resolve(__dirname, '../../../../../../')

describe('system package identity', () => {
  it('routes the pure-JS framework packages (system, types, sdk) through the live-sync gate', () => {
    expect(SYSTEM_PACKAGE).toBe('@camstack/system')
    // Framework packages: `dist/` mirrored into the live hub closure by
    // `syncFrameworkDist`, so a capability change ships via
    // `camstack deploy packages/types` with NO image rebuild.
    expect(isFrameworkPackage('@camstack/system')).toBe(true)
    expect(isFrameworkPackage('@camstack/types')).toBe(true)
    expect(isFrameworkPackage('@camstack/sdk')).toBe(true)
    // shm-ring ships a native `.node` prebuild the dist-only mirror can't
    // rebuild — it stays on the native-aware install path.
    expect(isFrameworkPackage('@camstack/shm-ring')).toBe(false)
    expect(isFrameworkPackage('@camstack/addon-pipeline')).toBe(false)
  })

  it('only @camstack/system declares camstack.system:true', () => {
    const pkgs = ['types', 'sdk']
    for (const p of pkgs) {
      const m = JSON.parse(
        readFileSync(resolve(MONOREPO_ROOT, `packages/${p}/package.json`), 'utf8'),
      ) as Record<string, unknown> & { camstack?: { system?: unknown } }
      expect(m.camstack?.system, p).toBe(false)
    }
    const sys = JSON.parse(
      readFileSync(resolve(MONOREPO_ROOT, 'packages/system/package.json'), 'utf8'),
    ) as Record<string, unknown> & { camstack?: { system?: unknown } }
    expect(sys.camstack?.system).toBe(true)
  })
})
