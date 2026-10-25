/**
 * `pipelineOrchestrator.setCameraStepSettings` (D754) — the router boundary.
 *
 * Admin-only (it changes what a camera's detector drops), keyed by device id
 * so a scoped token is judged per camera. `settings: null` reaches the
 * provider — it is how a step's camera-wide layer is cleared.
 */
import type { CapabilityDefinition } from '@camstack/types'
import {
  ACCESS_ROLES,
  buildRoleScopes,
  type CapabilityMethodSchema,
  pipelineOrchestratorCapability,
  resolveMethodAuth,
  type TokenScope,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

const pipelineOrchestratorDef: CapabilityDefinition = pipelineOrchestratorCapability

const VALID = { deviceId: 101, addonId: 'object-detection', settings: { minConfidencePerson: 0.7 } }

function roleScopes(roleId: (typeof ACCESS_ROLES)[number]['id']): readonly TokenScope[] {
  return buildRoleScopes({ roleId, selector: { kind: 'all' }, includeLinked: true })
}

function provider() {
  const setCameraStepSettings = vi.fn(async () => ({ success: true as const }))
  return { setCameraStepSettings }
}

describe('pipelineOrchestrator.setCameraStepSettings — router', () => {
  it('resolves to admin', () => {
    const all: Readonly<Record<string, CapabilityMethodSchema>> =
      pipelineOrchestratorCapability.methods
    const schema = all['setCameraStepSettings']
    if (schema === undefined) throw new Error('setCameraStepSettings no longer exists')
    expect(resolveMethodAuth(pipelineOrchestratorDef, schema)).toBe('admin')
  })

  it('viewer, operator and manager are refused by the tier', async () => {
    const p = provider()
    const router = buildCapRouterForTest('pipeline-orchestrator', () => p)
    for (const roleId of ACCESS_ROLES.map((r) => r.id)) {
      const ctx = makeCtx('user', { scopes: roleScopes(roleId) })
      const result = await invokeProcedure(router, 'setCameraStepSettings', ctx, VALID)
      expect(result.ok, `${roleId} reached setCameraStepSettings`).toBe(false)
      if (!result.ok) expect(result.message).toBe('Admin required')
    }
    expect(p.setCameraStepSettings).not.toHaveBeenCalled()
  })

  it('an admin reaches the provider with a bag, and with null', async () => {
    const p = provider()
    const router = buildCapRouterForTest('pipeline-orchestrator', () => p)
    expect(
      (await invokeProcedure(router, 'setCameraStepSettings', makeCtx('admin'), VALID)).ok,
    ).toBe(true)
    const cleared = await invokeProcedure(router, 'setCameraStepSettings', makeCtx('admin'), {
      deviceId: 101,
      addonId: 'object-detection',
      settings: null,
    })
    expect(cleared.ok).toBe(true)
    expect(p.setCameraStepSettings).toHaveBeenCalledTimes(2)
  })

  it('a missing addonId never reaches the provider', async () => {
    const p = provider()
    const router = buildCapRouterForTest('pipeline-orchestrator', () => p)
    const result = await invokeProcedure(router, 'setCameraStepSettings', makeCtx('admin'), {
      deviceId: 101,
      settings: {},
    })
    expect(result.ok).toBe(false)
    expect(p.setCameraStepSettings).not.toHaveBeenCalled()
  })
})
