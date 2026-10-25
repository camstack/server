/**
 * Boot-time inventory of host-provided packages — D45 enforcement step 2.
 *
 * D45: "more than one copy of a host-provided package on a node is an error,
 * reported loudly, not a warning nobody reads." The record exists because one
 * agent held FOUR copies of `@camstack/system` (1.2.28 / 1.2.28 / 1.2.0 /
 * 1.2.30) and every one of them could be truthfully quoted as "the version",
 * while three consecutive diagnoses of which one ran were each disproved by the
 * next measurement.
 *
 * But two of those four are EXPECTED by design: the `/opt` image seeds are baked
 * into the image and deliberately shadowed by the `/data/server-root/current`
 * deposit on every `applyServerUpdate`. Reporting them as a violation at every
 * boot trained the operator to scroll past the banner — which is exactly the
 * failure D45 was written to prevent. The detector therefore classifies WHERE a
 * copy sits, and only screams for a location nobody deposits on purpose or for
 * two copies that could both be the one that runs.
 */
import { describe, expect, it } from 'vitest'
import {
  formatInventoryReport,
  formatShadowingNotes,
  HOST_PROVIDED_PACKAGES,
  hostProvidedSearchRoots,
  type InventoryFs,
  type InventoryRoot,
  inventoryHostProvided,
  type RootExpectation,
  seedNodeModulesRoots,
} from '../package-inventory.js'

/** An in-memory node layout: package dir → version in its package.json. */
function fakeFs(tree: Record<string, string | null>): InventoryFs {
  return {
    exists: (p) => Object.hasOwn(tree, p),
    readVersion: (p) => tree[p] ?? null,
    realPath: (p) => p,
  }
}

/** Terse root builder so a layout reads as a layout in the tests below. */
function root(p: string, expectation: RootExpectation): InventoryRoot {
  return { path: p, expectation }
}

const ACTIVE_ROOT = '/data/server-root/current/node_modules'
const SEED_HUB = '/opt/camstack-hub/node_modules'
const SEED_FRAMEWORK = '/opt/camstack-seed-framework/node_modules'
const STALE_FRAMEWORK = '/data/framework/node_modules'

/** The layout every node in the fleet boots with: the deposit plus two seeds. */
const FLEET_ROOTS: readonly InventoryRoot[] = [
  root(ACTIVE_ROOT, 'active'),
  root(SEED_HUB, 'seed'),
  root(SEED_FRAMEWORK, 'seed'),
]

function expectationOf(roots: readonly InventoryRoot[], p: string): RootExpectation | undefined {
  return roots.find((r) => r.path === p)?.expectation
}

describe('hostProvidedSearchRoots', () => {
  it('scans NODE_PATH, the closure, the legacy framework dir, /data/addons and the image seeds', () => {
    const roots = hostProvidedSearchRoots({
      nodePath: '/data/server-root/current/node_modules:/opt/camstack-hub/node_modules',
      pathSeparator: ':',
      dataDir: '/data',
      serverNodeModules: ACTIVE_ROOT,
      seedRoots: [SEED_HUB, SEED_FRAMEWORK],
    })
    const paths = roots.map((r) => r.path)

    expect(paths).toContain(ACTIVE_ROOT)
    expect(paths).toContain(SEED_HUB)
    expect(paths).toContain(SEED_FRAMEWORK)
    expect(paths).toContain(STALE_FRAMEWORK)
    // `/data/addons/@camstack/system` is the bootstrap-install layout D45
    // forbids — the package sits DIRECTLY under the addons dir, so the addons
    // dir is itself a search root.
    expect(paths).toContain('/data/addons')
  })

  it('classifies the active deposit, the image seeds and everything else', () => {
    const roots = hostProvidedSearchRoots({
      nodePath: undefined,
      pathSeparator: ':',
      dataDir: '/data',
      serverNodeModules: ACTIVE_ROOT,
      seedRoots: [SEED_HUB, SEED_FRAMEWORK],
    })

    expect(expectationOf(roots, ACTIVE_ROOT)).toBe('active')
    // Image-baked, deliberately shadowed by the deposit on every release.
    expect(expectationOf(roots, SEED_HUB)).toBe('seed')
    expect(expectationOf(roots, SEED_FRAMEWORK)).toBe('seed')
    // Nobody deposits these on purpose — they are the real violations.
    expect(expectationOf(roots, STALE_FRAMEWORK)).toBe('unexpected')
    expect(expectationOf(roots, '/data/addons')).toBe('unexpected')
  })

  it('classifies a NODE_PATH entry by WHICH directory it names, not by being on NODE_PATH', () => {
    const roots = hostProvidedSearchRoots({
      nodePath: `${SEED_HUB}:/somebody/elses/node_modules`,
      pathSeparator: ':',
      dataDir: '/data',
      serverNodeModules: ACTIVE_ROOT,
      seedRoots: [SEED_HUB, SEED_FRAMEWORK],
    })

    // A seed named twice (as a seed and on NODE_PATH) is still just the seed.
    expect(expectationOf(roots, SEED_HUB)).toBe('seed')
    // An extra resolution path is what D45 forbids adding — unexpected.
    expect(expectationOf(roots, '/somebody/elses/node_modules')).toBe('unexpected')
  })

  it('does not repeat a root that appears in NODE_PATH and as the closure', () => {
    const roots = hostProvidedSearchRoots({
      nodePath: '/closure/node_modules:/closure/node_modules',
      pathSeparator: ':',
      dataDir: '/data',
      serverNodeModules: '/closure/node_modules',
      seedRoots: [],
    })
    expect(roots.filter((r) => r.path === '/closure/node_modules')).toHaveLength(1)
    // The closure keeps its own classification even though NODE_PATH names it.
    expect(expectationOf(roots, '/closure/node_modules')).toBe('active')
  })

  it('tolerates an empty NODE_PATH', () => {
    const roots = hostProvidedSearchRoots({
      nodePath: undefined,
      pathSeparator: ':',
      dataDir: '/data',
      serverNodeModules: '/closure/node_modules',
      seedRoots: [],
    })
    expect(roots.map((r) => r.path)).toContain('/closure/node_modules')
  })
})

describe('inventoryHostProvided', () => {
  it('reports ONE copy per package as clean', () => {
    const fs = fakeFs({
      '/closure/node_modules/@camstack/system': '1.2.36',
      '/closure/node_modules/@camstack/types': '1.2.23',
      '/closure/node_modules/@camstack/sdk': '1.2.20',
    })
    const result = inventoryHostProvided([root('/closure/node_modules', 'active')], fs)

    expect(result.violations).toEqual([])
    expect(result.copies).toHaveLength(3)
    expect(result.copies.every((c) => c.version !== null)).toBe(true)
  })

  it('finds every copy of a duplicated package, with path AND version', () => {
    const fs = fakeFs({
      [`${SEED_HUB}/@camstack/system`]: '1.2.28',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.28',
      [`${STALE_FRAMEWORK}/@camstack/system`]: '1.2.0',
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.30',
    })
    const result = inventoryHostProvided([...FLEET_ROOTS, root(STALE_FRAMEWORK, 'unexpected')], fs)

    expect(result.violations).toEqual(['@camstack/system'])
    const system = result.copies.filter((c) => c.pkg === '@camstack/system')
    expect(system).toHaveLength(4)
    expect(system.map((c) => c.version).sort()).toEqual(['1.2.0', '1.2.28', '1.2.28', '1.2.30'])
    // A version alone is what misled: every entry carries its path.
    expect(system.every((c) => c.path.length > 0)).toBe(true)
  })

  it('does NOT call the image seeds a violation — the deposit shadows them every release', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.100',
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.78',
    })
    const result = inventoryHostProvided(FLEET_ROOTS, fs)

    // Three copies, and all three are exactly where the image put them.
    expect(result.copies).toHaveLength(3)
    expect(result.violations).toEqual([])
    const system = result.packages.find((p) => p.pkg === '@camstack/system')
    expect(system?.activeCandidates.map((c) => c.path)).toEqual([`${ACTIVE_ROOT}/@camstack/system`])
    expect(system?.shadowedSeeds).toHaveLength(2)
    expect(system?.unexpected).toEqual([])
  })

  it('screams for an UNEXPECTED location even when the seeds are shadowed', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.100',
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.78',
      [`${STALE_FRAMEWORK}/@camstack/system`]: '1.2.0',
    })
    const result = inventoryHostProvided([...FLEET_ROOTS, root(STALE_FRAMEWORK, 'unexpected')], fs)

    expect(result.violations).toEqual(['@camstack/system'])
    const system = result.packages.find((p) => p.pkg === '@camstack/system')
    expect(system?.unexpected.map((c) => c.path)).toEqual([`${STALE_FRAMEWORK}/@camstack/system`])
  })

  it('screams when two copies could BOTH be the one that runs', () => {
    // No deposit for this package: the two seeds are then rival candidates and
    // "which one runs" is back to being a module-resolution outcome.
    const fs = fakeFs({
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.28',
    })
    const result = inventoryHostProvided(FLEET_ROOTS, fs)

    expect(result.violations).toEqual(['@camstack/system'])
    const system = result.packages.find((p) => p.pkg === '@camstack/system')
    expect(system?.activeCandidates).toHaveLength(2)
    expect(system?.shadowedSeeds).toEqual([])
  })

  it('accepts a single seed copy with no deposit — one copy is one copy', () => {
    const fs = fakeFs({ [`${SEED_HUB}/@camstack/system`]: '1.2.78' })
    const result = inventoryHostProvided(FLEET_ROOTS, fs)
    expect(result.violations).toEqual([])
  })

  it('counts a copy installed under /data/addons — the layout D45 forbids', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.36',
      '/data/addons/@camstack/system': '1.1.57',
    })
    const result = inventoryHostProvided(
      [root(ACTIVE_ROOT, 'active'), root('/data/addons', 'unexpected')],
      fs,
    )
    expect(result.violations).toEqual(['@camstack/system'])
  })

  it('does NOT count the same directory twice when two roots resolve to it', () => {
    const tree: Record<string, string> = {
      '/closure/node_modules/@camstack/system': '1.2.36',
      '/symlinked/node_modules/@camstack/system': '1.2.36',
    }
    const fs: InventoryFs = {
      exists: (p) => Object.hasOwn(tree, p),
      readVersion: (p) => tree[p] ?? null,
      // Both roots are the same directory on disk.
      realPath: () => '/closure/node_modules/@camstack/system',
    }
    const result = inventoryHostProvided(
      [root('/closure/node_modules', 'active'), root('/symlinked/node_modules', 'unexpected')],
      fs,
    )
    expect(result.violations).toEqual([])
    expect(result.copies).toHaveLength(1)
  })

  it('records a copy whose package.json will not parse rather than dropping it', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.36',
      '/data/addons/@camstack/system': null,
    })
    const result = inventoryHostProvided(
      [root(ACTIVE_ROOT, 'active'), root('/data/addons', 'unexpected')],
      fs,
    )
    // An unreadable copy is still a copy — dropping it would under-report.
    expect(result.violations).toEqual(['@camstack/system'])
    expect(
      result.copies.find((c) => c.path === '/data/addons/@camstack/system')?.version,
    ).toBeNull()
  })

  it('covers system, types and sdk by default', () => {
    expect(HOST_PROVIDED_PACKAGES).toContain('@camstack/system')
    expect(HOST_PROVIDED_PACKAGES).toContain('@camstack/types')
    expect(HOST_PROVIDED_PACKAGES).toContain('@camstack/sdk')
  })
})

describe('seedNodeModulesRoots', () => {
  it('enumerates /opt/<name>/node_modules instead of hardcoding seed names', () => {
    const present = new Set(['/opt', SEED_HUB, SEED_FRAMEWORK])
    const roots = seedNodeModulesRoots({
      existsSync: (p) => present.has(p),
      readdirSync: () => ['camstack-hub', 'camstack-seed-framework', 'not-a-package-tree'],
    })
    expect(roots).toEqual([SEED_HUB, SEED_FRAMEWORK])
  })

  it('returns nothing when /opt does not exist (every dev machine)', () => {
    expect(
      seedNodeModulesRoots({
        existsSync: () => false,
        readdirSync: () => {
          throw new Error('should not be called')
        },
      }),
    ).toEqual([])
  })

  it('returns nothing rather than throwing when /opt cannot be read', () => {
    expect(
      seedNodeModulesRoots({
        existsSync: () => true,
        readdirSync: () => {
          throw new Error('EACCES')
        },
      }),
    ).toEqual([])
  })
})

describe('formatInventoryReport', () => {
  it('names every copy with its path and version', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.30',
      [`${STALE_FRAMEWORK}/@camstack/system`]: '1.2.0',
    })
    const result = inventoryHostProvided(
      [root(ACTIVE_ROOT, 'active'), root(STALE_FRAMEWORK, 'unexpected')],
      fs,
    )
    const report = formatInventoryReport(result)

    expect(report).toContain('@camstack/system')
    expect(report).toContain(`${STALE_FRAMEWORK}/@camstack/system`)
    expect(report).toContain('1.2.0')
    expect(report).toContain('1.2.30')
    // It must say what is wrong, not merely list paths.
    expect(report).toMatch(/2 copies/i)
    // …and WHICH copy is the one nobody deposited on purpose.
    expect(report).toMatch(/unexpected/i)
  })

  it('is empty when the node is clean, so a good boot stays quiet', () => {
    const fs = fakeFs({ [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.36' })
    const result = inventoryHostProvided([root(ACTIVE_ROOT, 'active')], fs)
    expect(formatInventoryReport(result)).toBe('')
  })

  it('is empty for the fleet layout — an expected seed is not a violation banner', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.100',
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.78',
      [`${ACTIVE_ROOT}/@camstack/types`]: '1.2.100',
      [`${SEED_HUB}/@camstack/types`]: '1.2.78',
    })
    expect(formatInventoryReport(inventoryHostProvided(FLEET_ROOTS, fs))).toBe('')
  })

  it('says WHICH copies could both run when two candidates conflict', () => {
    const fs = fakeFs({
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.28',
    })
    const report = formatInventoryReport(inventoryHostProvided(FLEET_ROOTS, fs))
    expect(report).toMatch(/D45 violation/)
    expect(report).toContain(`${SEED_HUB}/@camstack/system`)
    expect(report).toContain(`${SEED_FRAMEWORK}/@camstack/system`)
  })
})

describe('the inventory is never fatal', () => {
  /**
   * Operator directive, 2026-08-12: "non dovremmo mai prevenire il boot". The
   * `CAMSTACK_INVENTORY_STRICT=1` refusal is gone and no flag replaces it — a
   * node that will not start records nothing, and every layout this detector
   * describes is survivable at runtime and fixable by an operator with a shell.
   * The inverse of the test that used to pin the refusal.
   *
   * `scripts/check-inventory-never-fatal.ts` holds the launcher side, which a
   * unit test cannot reach without booting a node.
   */
  const worstLayout: Record<string, string | null> = {
    [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.100',
    [`${SEED_HUB}/@camstack/system`]: '1.2.78',
    [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.28',
    [`${STALE_FRAMEWORK}/@camstack/system`]: '1.2.0',
    '/data/addons/@camstack/system': null,
    [`${STALE_FRAMEWORK}/@camstack/types`]: '0.9.0',
  }
  const worstRoots: readonly InventoryRoot[] = [
    ...FLEET_ROOTS,
    root(STALE_FRAMEWORK, 'unexpected'),
    root('/data/addons', 'unexpected'),
  ]

  it('describes the worst layout on record without throwing', () => {
    const run = (): void => {
      const result = inventoryHostProvided(worstRoots, fakeFs(worstLayout))
      formatInventoryReport(result)
      formatShadowingNotes(result)
    }
    expect(run).not.toThrow()
  })

  it('reports the violation as a STRING, so the caller can only log it', () => {
    const result = inventoryHostProvided(worstRoots, fakeFs(worstLayout))
    // Two packages in violation, and the whole verdict is data — there is no
    // fatal flag, no exit code and no thrown error anywhere in the surface.
    expect(result.violations).toEqual(['@camstack/system', '@camstack/types'])
    expect(typeof formatInventoryReport(result)).toBe('string')
    expect(formatInventoryReport(result)).not.toBe('')
  })

  it('survives a layout it cannot read at all', () => {
    const hostile: InventoryFs = {
      exists: () => true,
      readVersion: () => null,
      realPath: (p) => p,
    }
    const run = (): string => formatInventoryReport(inventoryHostProvided(worstRoots, hostile))
    expect(run).not.toThrow()
    expect(run()).toContain('<unreadable package.json>')
  })
})

describe('formatShadowingNotes', () => {
  it('states the expected shadowing in ONE compact line per package', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.100',
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.78',
    })
    const notes = formatShadowingNotes(inventoryHostProvided(FLEET_ROOTS, fs))

    expect(notes).toHaveLength(1)
    const note = notes[0] ?? ''
    expect(note).not.toContain('\n')
    expect(note).toContain('@camstack/system')
    expect(note).toContain('seed 1.2.78 shadowed by active 1.2.100')
    // Not a violation banner: this is the documented behaviour of every release.
    expect(note).not.toMatch(/violation/i)
  })

  it('collapses two seeds at the same version instead of repeating it', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.100',
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.78',
    })
    const note = formatShadowingNotes(inventoryHostProvided(FLEET_ROOTS, fs))[0] ?? ''
    expect(note.match(/1\.2\.78/g)).toHaveLength(1)
  })

  it('names both seed versions when the seeds disagree with each other', () => {
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.100',
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${SEED_FRAMEWORK}/@camstack/system`]: '1.2.28',
    })
    const note = formatShadowingNotes(inventoryHostProvided(FLEET_ROOTS, fs))[0] ?? ''
    expect(note).toContain('1.2.78')
    expect(note).toContain('1.2.28')
  })

  it('says nothing when there is no seed to shadow', () => {
    const fs = fakeFs({ [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.36' })
    expect(formatShadowingNotes(inventoryHostProvided([root(ACTIVE_ROOT, 'active')], fs))).toEqual(
      [],
    )
  })

  it('stays silent for a package already named in the loud report', () => {
    // The banner lists every copy of a violating package; a reassuring
    // "expected shadowing" line next to it would read as verification.
    const fs = fakeFs({
      [`${ACTIVE_ROOT}/@camstack/system`]: '1.2.100',
      [`${SEED_HUB}/@camstack/system`]: '1.2.78',
      [`${STALE_FRAMEWORK}/@camstack/system`]: '1.2.0',
    })
    const result = inventoryHostProvided(
      [root(ACTIVE_ROOT, 'active'), root(SEED_HUB, 'seed'), root(STALE_FRAMEWORK, 'unexpected')],
      fs,
    )
    expect(result.violations).toEqual(['@camstack/system'])
    expect(formatShadowingNotes(result)).toEqual([])
  })
})

/**
 * The guard spent every boot accusing the healthy layout.
 *
 * Live hub, 2026-08-25: the launcher resolved `@camstack/system@1.2.126` from
 * `/data/server-root/current/node_modules` and logged it as the framework dir
 * on NODE_PATH — then the very next line called that same directory
 * "UNEXPECTED — remove it", and, left with the two baked seeds as the only
 * remaining candidates, declared them "CONFLICTS — could run" against each
 * other. The runtime's own sweep disagreed in the same boot: `single-copy
 * cleanup — 0 copy(ies) to remove`.
 *
 * Cause: `serverNodeModules` is `@camstack/server/node_modules`, the NESTED
 * tree for that package's own dependencies. The framework packages resolve one
 * level up, from the closure — which arrived only through NODE_PATH and so fell
 * through to `unexpected`.
 *
 * A guard that fires on the healthy state is ignored when it fires on the
 * broken one. That is the failure D45 exists to catch, so it is the one thing
 * this guard must not do itself.
 */
describe('the closure directory is active, not unexpected', () => {
  const seedRoots = ['/opt/camstack-hub/node_modules', '/opt/camstack-seed-framework/node_modules']
  const closure = '/data/server-root/current/node_modules'
  const nested = '/data/server-root/current/node_modules/@camstack/server/node_modules'

  function rootsFor(frameworkRoots?: readonly string[]) {
    return hostProvidedSearchRoots({
      nodePath: [closure, ...seedRoots].join(':'),
      pathSeparator: ':',
      dataDir: '/data',
      serverNodeModules: nested,
      seedRoots,
      ...(frameworkRoots === undefined ? {} : { frameworkRoots }),
    })
  }

  it('classifies the framework closure as active when it is declared', () => {
    const roots = rootsFor([closure])
    expect(roots.find((r) => r.path === closure)?.expectation).toBe('active')
    expect(roots.find((r) => r.path === nested)?.expectation).toBe('active')
  })

  it('keeps the baked seeds as seeds, so they are shadowed rather than in conflict', () => {
    const roots = rootsFor([closure])
    for (const seed of seedRoots) {
      expect(roots.find((r) => r.path === seed)?.expectation).toBe('seed')
    }
  })

  it('reproduces the old misclassification when the closure is NOT declared', () => {
    // This is the bug, pinned: without `frameworkRoots` the directory the
    // framework actually resolves from is "unexpected".
    const roots = rootsFor()
    expect(roots.find((r) => r.path === closure)?.expectation).toBe('unexpected')
  })
})
