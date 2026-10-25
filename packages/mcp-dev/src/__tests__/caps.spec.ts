import { describe, expect, it } from 'vitest'
import { requireWorkspaceRoot } from '@camstack/develop'
import { planCapability } from '../caps/plan.js'
import { scaffoldCapability } from '../caps/scaffold.js'
import { getEnrichedCapability } from '../caps/enriched.js'
import { capShipPlan } from '../caps/ship.js'
import { isDeniedCommand } from '../ci/affected.js'
import { affectedChecks } from '../ci/affected.js'

describe('caps + ci helpers', () => {
  const root = requireWorkspaceRoot()

  it('plans a device-native archetype from purpose text', () => {
    const plan = planCapability(root, {
      purpose: 'per-device native sensor via BaseDevice registerNativeCap',
    })
    expect(plan.archetype).toBe('device-native')
    expect(plan.plan.exampleCap).toBeTruthy()
  })

  it('scaffolds dry-run without writing', () => {
    const result = scaffoldCapability({
      workspaceRoot: root,
      name: 'mcp-dev-probe-cap',
      archetype: 'system-singleton',
      apply: false,
    })
    expect(result.dryRun).toBe(true)
    expect(result.files.some((f) => f.path.endsWith('.cap.ts'))).toBe(true)
  })

  it('enriches an existing capability with methods', () => {
    const motion = getEnrichedCapability(root, 'motion')
    expect(motion).toBeTruthy()
    expect(motion!.deviceNative).toBe(true)
    expect(motion!.methods.length).toBeGreaterThan(0)
  })

  it('cap_ship_plan marks force-publish for new methods', () => {
    const plan = capShipPlan(['motion'], 'new-method')
    expect(plan.forcePublishSystem).toBe(true)
    expect(plan.steps.length).toBeGreaterThan(2)
  })

  it('affected_checks maps cap files and denies checks.yml', () => {
    expect(isDeniedCommand('gh workflow run checks.yml')).toBe(true)
    const { checks } = affectedChecks(root, {
      paths: ['packages/types/src/capabilities/motion.cap.ts'],
      gitDiff: false,
    })
    expect(checks.some((c) => c.id === 'codegen:check')).toBe(true)
    expect(checks.every((c) => !c.command.includes('checks.yml'))).toBe(true)
  })
})
