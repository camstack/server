import * as fs from 'node:fs'
import * as path from 'node:path'
import { listCapabilities } from '@camstack/develop'
import { ARCHETYPES, type CapArchetype, inferArchetype } from './archetypes.js'

export interface CapPlanResult {
  readonly needCapability: boolean
  readonly rationale: string
  readonly alternatives: readonly string[]
  readonly archetype: CapArchetype
  readonly plan: (typeof ARCHETYPES)[CapArchetype]
  readonly similarCaps: readonly { name: string; relativeFile: string }[]
}

export function planCapability(
  workspaceRoot: string,
  args: { purpose: string; archetype?: CapArchetype },
): CapPlanResult {
  const purpose = args.purpose.trim()
  const alternatives: string[] = []
  let needCapability = true
  let rationale = 'New state/behaviour shared across addons — a capability is appropriate.'

  const lower = purpose.toLowerCase()
  if (/enumerat|list.?providers|who provides/.test(lower)) {
    needCapability = false
    rationale = 'Prefer addons.listCapabilityProviders({ capName }) over a new orchestrator cap.'
    alternatives.push('addons.listCapabilityProviders')
  }
  if (/addon.?config|settings schema|globalsettings/.test(lower)) {
    needCapability = false
    rationale =
      'Prefer globalSettingsSchema() + addon-settings; NodeAddonsSettingsPanel already renders it.'
    alternatives.push('addon-settings', 'globalSettingsSchema()')
  }
  if (/enable|disable.?provider/.test(lower)) {
    needCapability = false
    rationale = 'Prefer addons.setCapabilityProviderEnabled.'
    alternatives.push('addons.setCapabilityProviderEnabled')
  }
  if (/add(itive)? field|extend method|optional field/.test(lower)) {
    needCapability = false
    rationale =
      'Additive field on an existing method needs only the providing addon redeployed — cheaper than a new cap.'
    alternatives.push('extend existing method input/output')
  }

  const archetype = args.archetype ?? inferArchetype(purpose)
  const plan = ARCHETYPES[archetype]
  const similar = listCapabilities(workspaceRoot)
    .filter((c) => {
      const hay = `${c.name} ${c.relativeFile}`.toLowerCase()
      return purpose
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 3)
        .some((t) => hay.includes(t))
    })
    .slice(0, 8)
    .map((c) => ({ name: c.name, relativeFile: c.relativeFile }))

  // Always include the archetype example if present
  const examplePath = path.join(
    workspaceRoot,
    'packages',
    'types',
    'src',
    'capabilities',
    `${plan.exampleCap}.cap.ts`,
  )
  if (fs.existsSync(examplePath) && !similar.some((s) => s.name === plan.exampleCap)) {
    similar.unshift({
      name: plan.exampleCap,
      relativeFile: path.relative(workspaceRoot, examplePath),
    })
  }

  return {
    needCapability,
    rationale,
    alternatives,
    archetype,
    plan,
    similarCaps: similar,
  }
}
