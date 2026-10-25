/**
 * Post-boot convergence to ONE copy — and the gates that stop it bricking a node.
 *
 * Operator, 2026-08-13: the system seed stays in the image as the first-boot /
 * fallback source, and once a node *has booted correctly* the redundant
 * DATA-side copies are removed; the end state is one version of everything per
 * node, hub and agent identical.
 *
 * The dangerous half is the timing, not the removal. Every copy this deletes is
 * a copy something could still be resolving:
 *
 * - in BAKED mode (no `<dataDir>/server-root/current`) the node is running FROM
 *   the fallback tree. Deleting it there is deleting the running framework.
 * - a closure that did not resolve `@camstack/system` is the case the fallback
 *   exists for. Cleaning then removes the recovery path at the exact moment it
 *   is needed.
 * - a tree still on `NODE_PATH` is a live resolution path whatever the mode
 *   says.
 *
 * So the plan is gated three times over and the executor refuses a blocked plan
 * a second time. Each gate has a test that fails when it is removed — verified
 * by neutralisation, because a gate nothing checks is a comment.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CleanupCandidate, CleanupFs, DiscoveryFs } from '../single-copy-cleanup.js'
import {
  discoverRedundantCopies,
  executeSingleCopyCleanup,
  formatCleanupPlan,
  isCleanupEnabled,
  planSingleCopyCleanup,
} from '../single-copy-cleanup.js'

const ACTIVE_ROOT = '/data/server-root/current'
const CLOSURE_SYSTEM = `${ACTIVE_ROOT}/node_modules/@camstack/system/package.json`

const LEGACY_FRAMEWORK: CleanupCandidate = {
  kind: 'legacy-framework-tree',
  path: '/data/framework',
  pkg: null,
  version: '1.2.78',
}
const ADDON_ROOT_SYSTEM: CleanupCandidate = {
  kind: 'addon-root-closure-copy',
  path: '/data/addons/@camstack/system',
  pkg: '@camstack/system',
  version: '1.2.78',
}

function healthyInput(overrides: Partial<Parameters<typeof planSingleCopyCleanup>[0]> = {}) {
  return {
    activeRoot: ACTIVE_ROOT,
    closureResolvedFrom: CLOSURE_SYSTEM,
    bootHealthy: true,
    nodePathEntries: [`${ACTIVE_ROOT}/node_modules`],
    candidates: [LEGACY_FRAMEWORK, ADDON_ROOT_SYSTEM],
    ...overrides,
  }
}

describe('planSingleCopyCleanup — the happy path', () => {
  it('removes the data-side copies after a healthy boot from the active closure', () => {
    const plan = planSingleCopyCleanup(healthyInput())

    expect(plan.blocked).toBe(false)
    expect(plan.remove.map((c) => c.path)).toEqual([
      '/data/framework',
      '/data/addons/@camstack/system',
    ])
    expect(plan.keep).toEqual([])
  })

  it('removes nothing when there is nothing to remove, and is not blocked', () => {
    const plan = planSingleCopyCleanup(healthyInput({ candidates: [] }))
    expect(plan.blocked).toBe(false)
    expect(plan.remove).toEqual([])
  })
})

describe('planSingleCopyCleanup — the gates', () => {
  it('refuses while the boot is not healthy — the copies ARE the recovery path', () => {
    const plan = planSingleCopyCleanup(healthyInput({ bootHealthy: false }))

    expect(plan.blocked).toBe(true)
    expect(plan.remove).toEqual([])
    expect(plan.blockedReason).toContain('healthy')
    expect(plan.keep).toHaveLength(2)
  })

  it('refuses in BAKED mode — with no active closure the fallback is what is running', () => {
    const plan = planSingleCopyCleanup(
      healthyInput({ activeRoot: null, closureResolvedFrom: '/opt/camstack-hub/node_modules' }),
    )

    expect(plan.blocked).toBe(true)
    expect(plan.blockedReason).toContain('baked')
    expect(plan.remove).toEqual([])
  })

  it('refuses when the process resolved @camstack/system OUTSIDE the active closure', () => {
    // The launcher logs this path every boot precisely because it is not
    // deducible: a copy under /data/addons or /data/framework can win.
    const plan = planSingleCopyCleanup(
      healthyInput({ closureResolvedFrom: '/data/addons/@camstack/system/package.json' }),
    )

    expect(plan.blocked).toBe(true)
    expect(plan.blockedReason).toContain('resolved')
    expect(plan.remove).toEqual([])
  })

  it('refuses when the closure resolved nothing at all', () => {
    const plan = planSingleCopyCleanup(healthyInput({ closureResolvedFrom: null }))
    expect(plan.blocked).toBe(true)
    expect(plan.remove).toEqual([])
  })
})

describe('planSingleCopyCleanup — per-candidate refusals', () => {
  it('never removes a path inside the active closure, healthy or not', () => {
    const inside: CleanupCandidate = {
      kind: 'addon-root-closure-copy',
      path: `${ACTIVE_ROOT}/node_modules/@camstack/system`,
      pkg: '@camstack/system',
      version: '1.2.84',
    }
    const plan = planSingleCopyCleanup(healthyInput({ candidates: [inside] }))

    expect(plan.remove).toEqual([])
    expect(plan.keep[0]?.reason).toContain('active closure')
  })

  it('never removes an image tree under /opt — that is the fallback source', () => {
    const seed: CleanupCandidate = {
      kind: 'legacy-framework-tree',
      path: '/opt/camstack-seed-framework/node_modules',
      pkg: null,
      version: '1.2.78',
    }
    const plan = planSingleCopyCleanup(healthyInput({ candidates: [seed] }))

    expect(plan.remove).toEqual([])
    expect(plan.keep[0]?.reason).toContain('image')
  })

  it('never removes a tree that is still on NODE_PATH', () => {
    const plan = planSingleCopyCleanup(
      healthyInput({
        nodePathEntries: [`${ACTIVE_ROOT}/node_modules`, '/data/framework/node_modules'],
      }),
    )

    expect(plan.remove.map((c) => c.path)).toEqual(['/data/addons/@camstack/system'])
    expect(plan.keep.map((k) => k.candidate.path)).toEqual(['/data/framework'])
    expect(plan.keep[0]?.reason).toContain('NODE_PATH')
  })
})

describe('executeSingleCopyCleanup', () => {
  function fakeFs(overrides: Partial<CleanupFs> = {}): CleanupFs {
    return {
      exists: () => true,
      rename: vi.fn(),
      remove: vi.fn(),
      ...overrides,
    }
  }

  it('renames aside FIRST, then deletes — the rename is what ends the shadowing', async () => {
    const order: string[] = []
    const fs = fakeFs({
      rename: vi.fn((from: string) => {
        order.push(`rename ${from}`)
      }),
      remove: vi.fn((target: string) => {
        order.push(`remove ${target}`)
      }),
    })
    const plan = planSingleCopyCleanup(healthyInput({ candidates: [ADDON_ROOT_SYSTEM] }))

    const result = await executeSingleCopyCleanup(plan, fs, () => {})

    expect(order[0]).toBe('rename /data/addons/@camstack/system')
    expect(order[1]).toMatch(/^remove \/data\/addons\/@camstack\/system\.removing-/)
    expect(result.removed).toEqual(['/data/addons/@camstack/system'])
    expect(result.failed).toEqual([])
  })

  it('counts a copy as removed when the rename succeeded but the delete did not', async () => {
    // A held-open native keeps the bytes; it no longer shadows anything, and
    // failing the whole sweep over residue would be worse than the residue.
    const fs = fakeFs({
      remove: vi.fn(() => {
        throw new Error('EBUSY')
      }),
    })
    const plan = planSingleCopyCleanup(healthyInput({ candidates: [ADDON_ROOT_SYSTEM] }))

    const result = await executeSingleCopyCleanup(plan, fs, () => {})

    expect(result.removed).toEqual(['/data/addons/@camstack/system'])
    expect(result.failed).toEqual([])
  })

  it('reports a copy it could not even rename — silence would read as success', async () => {
    const fs = fakeFs({
      rename: vi.fn(() => {
        throw new Error('EPERM')
      }),
    })
    const plan = planSingleCopyCleanup(healthyInput({ candidates: [ADDON_ROOT_SYSTEM] }))

    const result = await executeSingleCopyCleanup(plan, fs, () => {})

    expect(result.removed).toEqual([])
    expect(result.failed).toEqual(['/data/addons/@camstack/system'])
  })

  it('REFUSES a blocked plan — the second gate, in case a caller builds one by hand', async () => {
    const fs = fakeFs()
    const blocked = planSingleCopyCleanup(healthyInput({ bootHealthy: false }))

    const result = await executeSingleCopyCleanup(
      { ...blocked, remove: [LEGACY_FRAMEWORK] },
      fs,
      () => {},
    )

    expect(fs.rename).not.toHaveBeenCalled()
    expect(fs.remove).not.toHaveBeenCalled()
    expect(result.removed).toEqual([])
    expect(result.refused).toBe(true)
  })

  it('skips a candidate that has since disappeared', async () => {
    const fs = fakeFs({ exists: () => false })
    const plan = planSingleCopyCleanup(healthyInput({ candidates: [ADDON_ROOT_SYSTEM] }))

    const result = await executeSingleCopyCleanup(plan, fs, () => {})

    expect(fs.rename).not.toHaveBeenCalled()
    expect(result.removed).toEqual([])
  })

  it('logs every path it touches, with its version', async () => {
    const lines: string[] = []
    const plan = planSingleCopyCleanup(healthyInput({ candidates: [ADDON_ROOT_SYSTEM] }))

    await executeSingleCopyCleanup(plan, fakeFs(), (line) => lines.push(line))

    expect(lines.join('\n')).toContain('/data/addons/@camstack/system')
    expect(lines.join('\n')).toContain('1.2.78')
  })
})

describe('formatCleanupPlan', () => {
  it('says loudly why it did nothing — a blocked sweep must never look like a clean node', () => {
    const text = formatCleanupPlan(
      planSingleCopyCleanup(healthyInput({ bootHealthy: false })),
    ).join('\n')

    expect(text).toContain('blocked')
    expect(text).toContain('/data/framework')
    expect(text).toContain('/data/addons/@camstack/system')
  })

  it('names each copy it will remove, with its version and why it is redundant', () => {
    const text = formatCleanupPlan(planSingleCopyCleanup(healthyInput())).join('\n')

    expect(text).toContain('/data/framework')
    expect(text).toContain('1.2.78')
    expect(text).toContain('2 copy(ies)')
  })

  it('states the roster even when there is nothing to do', () => {
    const text = formatCleanupPlan(planSingleCopyCleanup(healthyInput({ candidates: [] }))).join(
      '\n',
    )
    expect(text).toContain('0 copy(ies)')
  })
})

describe('discoverRedundantCopies', () => {
  const FS_ALL: DiscoveryFs = {
    exists: () => true,
    readVersion: () => '1.2.78',
  }

  it('finds the legacy framework tree and every closure-provided copy under the addon root', () => {
    const found = discoverRedundantCopies(
      {
        dataDir: '/data',
        addonRoot: '/data/addons',
        closureProvides: () => true,
      },
      FS_ALL,
    )

    expect(found.map((c) => c.path)).toEqual([
      '/data/framework',
      '/data/addons/@camstack/system',
      '/data/addons/@camstack/types',
      '/data/addons/@camstack/sdk',
      '/data/addons/@camstack/ui-library',
    ])
    expect(found[0]?.kind).toBe('legacy-framework-tree')
    expect(found[1]?.pkg).toBe('@camstack/system')
  })

  it('never proposes a copy of a package the closure does NOT provide', () => {
    // The seed-when-unresolvable case: without it, a fresh deployment aborts
    // boot with "No addon provides required infrastructure capability
    // storage-provider". Deleting that copy would recreate exactly that.
    const found = discoverRedundantCopies(
      { dataDir: '/data', addonRoot: '/data/addons', closureProvides: () => false },
      FS_ALL,
    )
    expect(found.map((c) => c.path)).toEqual(['/data/framework'])
  })

  it('finds nothing on a node that is already converged', () => {
    const found = discoverRedundantCopies(
      { dataDir: '/data', addonRoot: '/data/addons', closureProvides: () => true },
      { exists: () => false, readVersion: () => null },
    )
    expect(found).toEqual([])
  })

  it('still reports a copy whose package.json will not parse — that is the worst kind', () => {
    const found = discoverRedundantCopies(
      {
        dataDir: '/data',
        addonRoot: '/data/addons',
        closureProvides: (pkg) => pkg === '@camstack/system',
      },
      { exists: (p) => p.includes('@camstack/system'), readVersion: () => null },
    )
    expect(found).toEqual([
      {
        kind: 'addon-root-closure-copy',
        path: '/data/addons/@camstack/system',
        pkg: '@camstack/system',
        version: null,
      },
    ])
  })
})

describe('isCleanupEnabled', () => {
  it('is ON by default — the operator asked for one copy per node', () => {
    expect(isCleanupEnabled({})).toBe(true)
    expect(isCleanupEnabled({ CAMSTACK_SINGLE_COPY_CLEANUP: 'on' })).toBe(true)
  })

  it('can be turned off from the outside, without editing code', () => {
    for (const raw of ['off', 'OFF', '0', 'false', ' off ']) {
      expect(isCleanupEnabled({ CAMSTACK_SINGLE_COPY_CLEANUP: raw })).toBe(false)
    }
  })
})
