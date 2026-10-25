/**
 * `pipelineOrchestrator.setCameraSensors` (G5, D676) — the router boundary.
 *
 * Admin-only (it rewires which devices start a camera's motion), and its
 * input is the D673 config schema: a numeric id in place of a stable ref, a
 * per-sensor mode outside the enum, an empty list or a duplicated ref never
 * reaches the provider. `null` does — it
 * is how an attachment is removed.
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

/** Widened the way the router builder sees each cap — `resolveMethodAuth` reads only `internal`. */
const pipelineOrchestratorDef: CapabilityDefinition = pipelineOrchestratorCapability

const PIR = { addonId: 'provider-homeassistant', stableId: 'binary_sensor.porch_pir' }
const VALID = { deviceId: 103, config: { sensors: [{ ...PIR, mode: 'in-addition' }] } }

function roleScopes(roleId: (typeof ACCESS_ROLES)[number]['id']): readonly TokenScope[] {
  return buildRoleScopes({ roleId, selector: { kind: 'all' }, includeLinked: true })
}

function provider() {
  const setCameraSensors = vi.fn(async () => ({ success: true as const }))
  return { setCameraSensors }
}

describe('pipelineOrchestrator.setCameraSensors — router', () => {
  it('resolves to admin', () => {
    const all: Readonly<Record<string, CapabilityMethodSchema>> =
      pipelineOrchestratorCapability.methods
    const schema = all['setCameraSensors']
    if (schema === undefined) throw new Error('setCameraSensors no longer exists')
    expect(resolveMethodAuth(pipelineOrchestratorDef, schema)).toBe('admin')
  })

  it('viewer, operator and manager are refused by the tier', async () => {
    const p = provider()
    const router = buildCapRouterForTest('pipeline-orchestrator', () => p)
    for (const roleId of ACCESS_ROLES.map((r) => r.id)) {
      const ctx = makeCtx('user', { scopes: roleScopes(roleId) })
      const result = await invokeProcedure(router, 'setCameraSensors', ctx, VALID)
      expect(result.ok, `${roleId} reached setCameraSensors`).toBe(false)
      // By the TIER — not a missing procedure, which would refuse everyone.
      if (!result.ok) expect(result.message).toBe('Admin required')
    }
    expect(p.setCameraSensors).not.toHaveBeenCalled()
  })

  it('an admin reaches the provider with the config, and with null', async () => {
    const p = provider()
    const router = buildCapRouterForTest('pipeline-orchestrator', () => p)
    expect((await invokeProcedure(router, 'setCameraSensors', makeCtx('admin'), VALID)).ok).toBe(
      true,
    )
    const cleared = await invokeProcedure(router, 'setCameraSensors', makeCtx('admin'), {
      deviceId: 103,
      config: null,
    })
    expect(cleared.ok).toBe(true)
    expect(p.setCameraSensors).toHaveBeenCalledTimes(2)
  })

  it('a config the D672 schema refuses never reaches the provider', async () => {
    const p = provider()
    const router = buildCapRouterForTest('pipeline-orchestrator', () => p)
    for (const config of [
      { sensors: [3299] },
      { sensors: [{ ...PIR, mode: 'sometimes' }] },
      { sensors: [] },
      { sensors: [PIR, PIR] },
    ]) {
      const result = await invokeProcedure(router, 'setCameraSensors', makeCtx('admin'), {
        deviceId: 103,
        config,
      })
      expect(result.ok, JSON.stringify(config)).toBe(false)
      if (!result.ok) expect(result.code).toBe('BAD_REQUEST')
    }
    expect(p.setCameraSensors).not.toHaveBeenCalled()
  })
})
