/**
 * `pipelineOrchestrator.requestOccupancyLook` (D691) — the router boundary.
 *
 * Admin-only: it makes the orchestrator attach a camera and spend a decode
 * dial. Its input is relative (`afterMs`) so the caller's clock never has to
 * agree with the hub's, and a malformed ask never reaches the provider.
 */
import type { CapabilityDefinition } from '@camstack/types'
import {
  type CapabilityMethodSchema,
  pipelineOrchestratorCapability,
  resolveMethodAuth,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

/** Widened the way the router builder sees each cap — `resolveMethodAuth` reads only `internal`. */
const pipelineOrchestratorDef: CapabilityDefinition = pipelineOrchestratorCapability

const ASK = { deviceId: 102, afterMs: 1_300, reason: 'occupancy-pending' }

function provider() {
  const requestOccupancyLook = vi.fn(async () => ({ scheduled: true, dueInMs: 3_300 }))
  return { requestOccupancyLook }
}

describe('pipelineOrchestrator.requestOccupancyLook — router', () => {
  it('resolves to admin', () => {
    const all: Readonly<Record<string, CapabilityMethodSchema>> =
      pipelineOrchestratorCapability.methods
    const schema = all['requestOccupancyLook']
    if (schema === undefined) throw new Error('requestOccupancyLook no longer exists')
    expect(resolveMethodAuth(pipelineOrchestratorDef, schema)).toBe('admin')
  })

  it('an admin reaches the provider with the ask, and gets its answer', async () => {
    const p = provider()
    const router = buildCapRouterForTest('pipeline-orchestrator', () => p)
    const result = await invokeProcedure(router, 'requestOccupancyLook', makeCtx('admin'), ASK)
    expect(result.ok, result.ok ? '' : result.message).toBe(true)
    expect(p.requestOccupancyLook).toHaveBeenCalledWith(ASK)
  })

  it('a malformed ask never reaches the provider', async () => {
    const p = provider()
    const router = buildCapRouterForTest('pipeline-orchestrator', () => p)
    for (const bad of [
      { ...ASK, deviceId: -1 },
      { deviceId: 102, reason: 'x' },
      { ...ASK, afterMs: 'soon' },
    ]) {
      const result = await invokeProcedure(router, 'requestOccupancyLook', makeCtx('admin'), bad)
      expect(result.ok, JSON.stringify(bad)).toBe(false)
    }
    expect(p.requestOccupancyLook).not.toHaveBeenCalled()
  })
})
