/**
 * Which dirs the agent scans — the single-copy collapse, on the agent.
 *
 * The defect these pin was measured on the live cluster 2026-08-11: both agents
 * carried `@camstack/system` in their addon root (1.2.61 / 1.2.62) while running
 * a 1.2.78 closure, because the old self-heal only wrote that copy when it was
 * ABSENT and nothing ever refreshed it. `bootCoreAddons` itself needs a broker
 * and real contexts, so the decision lives in `addon-scan.ts` as pure data —
 * the same extraction `infra-boot-plan.ts` got after 2026-08-08.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTINS_PACKAGE, planAgentAddonScan, resolveAddonPackageDirs } from '../addon-scan.js'

describe('resolveAddonPackageDirs', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-addon-scan-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writePkg(dir: string, name: string, version = '1.0.0'): void {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
  }

  it('finds scoped and flat packages, and skips exactly the named scoped one', () => {
    writePkg(path.join(root, '@camstack', 'system'), BUILTINS_PACKAGE)
    writePkg(
      path.join(root, '@camstack', 'addon-platform-probe-native'),
      '@camstack/addon-platform-probe-native',
    )
    writePkg(path.join(root, 'legacy-addon'), 'legacy-addon')

    const all = resolveAddonPackageDirs(root)
    expect(all.map((d) => path.basename(d)).sort()).toEqual([
      'addon-platform-probe-native',
      'legacy-addon',
      'system',
    ])

    // The non-framework infra provider must survive the skip — it is the reason
    // the scan exists at all.
    const skipped = resolveAddonPackageDirs(root, [BUILTINS_PACKAGE])
    expect(skipped.map((d) => path.basename(d)).sort()).toEqual([
      'addon-platform-probe-native',
      'legacy-addon',
    ])
  })

  it('matches the skip list the way AddonLoader.loadFromDirectory does', () => {
    // `<scope>/<name>` for a scoped dir — NOT the bare directory basename, or
    // the hub and the agent would exclude different things from one list.
    writePkg(path.join(root, '@camstack', 'system'), BUILTINS_PACKAGE)
    expect(resolveAddonPackageDirs(root, ['system'])).toHaveLength(1)
    expect(resolveAddonPackageDirs(root, ['@camstack/system'])).toHaveLength(0)
  })

  it('tolerates a missing addons dir', () => {
    expect(resolveAddonPackageDirs(path.join(root, 'nope'))).toEqual([])
  })
})

describe('planAgentAddonScan', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-addon-plan-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writePkg(dir: string, name: string, version = '1.0.0'): void {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
  }

  it('loads builtins from the CLOSURE and drops the addon-root copy', () => {
    // The live 2026-08-11 shape: a stale copy beside a current closure.
    writePkg(path.join(root, '@camstack', 'system'), BUILTINS_PACKAGE, '1.2.61')
    writePkg(path.join(root, '@camstack', 'addon-pipeline'), '@camstack/addon-pipeline')
    const closure = path.join(root, 'closure', 'node_modules', '@camstack', 'system')
    writePkg(closure, BUILTINS_PACKAGE, '1.2.78')

    const plan = planAgentAddonScan(root, closure)

    // Closure FIRST, and the stale copy nowhere. AddonLoader keys on
    // declaration.id, so a plan containing both would be last-load-wins —
    // the builtins a node runs would depend on readdir order.
    expect(plan[0]).toBe(closure)
    expect(plan.some((d) => d === path.join(root, '@camstack', 'system'))).toBe(false)
    expect(plan).toHaveLength(2)
  })

  it('is non-empty on a greenfield node with no addons at all', () => {
    // Guards the early return in `bootCoreAddons`: with the self-heal gone,
    // an empty addon root must still scan the closure, or the node exits
    // before the D87 guard can name what it is missing.
    const closure = path.join(root, 'closure', 'node_modules', '@camstack', 'system')
    writePkg(closure, BUILTINS_PACKAGE, '1.2.78')
    expect(planAgentAddonScan(path.join(root, 'addons'), closure)).toEqual([closure])
  })

  it('falls back to the addon-root copy when the closure is unresolvable', () => {
    // Near-impossible in a live agent (main.ts statically imports the package),
    // but a node with neither source must fail through the D87 guard, not boot
    // silently — so when there is no closure the copy is NOT skipped.
    const copy = path.join(root, '@camstack', 'system')
    writePkg(copy, BUILTINS_PACKAGE, '1.2.61')
    expect(planAgentAddonScan(root, null)).toEqual([copy])
  })
})
