import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  candidateDataRoots,
  formatAddonRootReport,
  inventoryAddonRoots,
  KNOWN_ELECTRON_APP_IDS,
  type AddonRootFs,
  type RivalRootInput,
} from '../addon-root-inventory'

/**
 * "One addon root per node" is only true if a second one is LOUD.
 *
 * Measured on the Mac agent 2026-08-07: four `addons/@camstack` trees on one
 * disk, holding `addon-pipeline` at 1.2.43 (live), 1.1.70, 1.1.59 and 1.1.1.
 * Every one of those is a true answer to "what version is on the Mac", and an
 * hour was spent on one of the three that no process had loaded since June.
 */

const HOME = '/Users/someone'

function input(overrides: Partial<RivalRootInput> = {}): RivalRootInput {
  return {
    dataDir: `${HOME}/Library/Application Support/@camstack/desktop/data`,
    activeAddonsDir: `${HOME}/Library/Application Support/@camstack/desktop/data/addons`,
    homeDir: HOME,
    platform: 'darwin',
    ...overrides,
  }
}

/** A described disk: scope dir → package name → version (null = unreadable). */
function fakeFs(layout: Record<string, Record<string, string | null>>): AddonRootFs {
  return {
    exists: (dir) => Object.hasOwn(layout, dir),
    listPackages: (scopeDir) => Object.keys(layout[scopeDir] ?? {}),
    readVersion: (packageDir) => {
      const scopeDir = path.dirname(packageDir)
      const name = path.basename(packageDir)
      return layout[scopeDir]?.[name] ?? null
    },
    realPath: (dir) => dir,
  }
}

const ACTIVE_SCOPE = `${HOME}/Library/Application Support/@camstack/desktop/data/addons/@camstack`
const LEGACY_SCOPE = `${HOME}/camstack-agent-data/addons/@camstack`
const RETIRED_APP_SCOPE = `${HOME}/Library/Application Support/@camstack/electron/data/addons/@camstack`

describe('candidateDataRoots', () => {
  it('covers every Electron app id the product has shipped', () => {
    const roots = candidateDataRoots(input())
    for (const appId of KNOWN_ELECTRON_APP_IDS) {
      expect(roots.some((r) => r.includes(`@camstack/${appId}`))).toBe(true)
    }
  })

  it('covers the pre-Electron agent data root', () => {
    expect(candidateDataRoots(input())).toContain(`${HOME}/camstack-agent-data`)
  })

  it('is empty without a home directory rather than scanning from /', () => {
    expect(candidateDataRoots(input({ homeDir: '' }))).toEqual([])
  })
})

describe('inventoryAddonRoots', () => {
  it('says nothing when the machine has exactly one addon root', () => {
    const result = inventoryAddonRoots(
      input(),
      fakeFs({ [ACTIVE_SCOPE]: { 'addon-pipeline': '1.2.43' } }),
    )

    expect(result.rivals).toEqual([])
    expect(formatAddonRootReport(result)).toBe('')
  })

  it('reports an abandoned data root, with the versions it would lie about', () => {
    const result = inventoryAddonRoots(
      input(),
      fakeFs({
        [ACTIVE_SCOPE]: { 'addon-pipeline': '1.2.43' },
        [LEGACY_SCOPE]: { 'addon-pipeline': '1.1.1', system: '1.1.1' },
      }),
    )

    expect(result.rivals).toHaveLength(1)
    expect(result.rivals[0]?.scopeDir).toBe(LEGACY_SCOPE)
    expect(result.rivals[0]?.packageCount).toBe(2)
    expect(result.rivals[0]?.sample).toContain('addon-pipeline@1.1.1')

    const report = formatAddonRootReport(result)
    expect(report).toContain(LEGACY_SCOPE)
    expect(report).toContain('addon-pipeline@1.1.1')
    // The live root must be named too — a warning that does not say which one
    // IS right sends the reader back to guessing.
    expect(report).toContain(ACTIVE_SCOPE)
  })

  it('reports every rival, not just the first', () => {
    const result = inventoryAddonRoots(
      input(),
      fakeFs({
        [ACTIVE_SCOPE]: { 'addon-pipeline': '1.2.43' },
        [LEGACY_SCOPE]: { 'addon-pipeline': '1.1.1' },
        [RETIRED_APP_SCOPE]: { 'addon-pipeline': '1.1.59' },
      }),
    )

    expect(result.rivals.map((r) => r.scopeDir).toSorted()).toEqual(
      [LEGACY_SCOPE, RETIRED_APP_SCOPE].toSorted(),
    )
  })

  it('does not report a candidate that is the SAME tree as the active root', () => {
    // A symlinked/bind-mounted data root is one root, not two. Crying wolf here
    // trains operators to ignore the warning that matters.
    const fs: AddonRootFs = {
      ...fakeFs({
        [ACTIVE_SCOPE]: { 'addon-pipeline': '1.2.43' },
        [LEGACY_SCOPE]: { 'addon-pipeline': '1.2.43' },
      }),
      realPath: () => '/real/addons/@camstack',
    }

    expect(inventoryAddonRoots(input(), fs).rivals).toEqual([])
  })

  it('records a package whose version cannot be read instead of dropping it', () => {
    const result = inventoryAddonRoots(
      input(),
      fakeFs({
        [ACTIVE_SCOPE]: { 'addon-pipeline': '1.2.43' },
        [LEGACY_SCOPE]: { 'addon-pipeline': null },
      }),
    )

    expect(result.rivals[0]?.sample).toEqual(['addon-pipeline@<unreadable>'])
  })
})
