import { describe, expect, it, vi } from 'vitest'
import { NodeDecodeLimitsSource } from '../node-decode-limits-source.js'

/**
 * The per-node decode limits (D365) are the orchestrator's agent-settings
 * entry for THIS node, read on the same cadence as the lease knobs — never a
 * copy kept warm in the runner (D224): a value the operator changes lands on
 * the next refresh, and a read that fails keeps the last known value.
 */
function logger() {
  return { info: vi.fn(), warn: vi.fn() }
}

function apiReturning(query: ReturnType<typeof vi.fn>) {
  return { pipelineOrchestrator: { getAgentSettings: { query } } }
}

describe('NodeDecodeLimitsSource', () => {
  it('starts empty — the resolver then falls to the cluster value or the RAM derivation', () => {
    expect(new NodeDecodeLimitsSource({ logger: logger(), nodeId: 'mac' }).current()).toEqual({})
  })

  it("reads THIS node's entry and keeps only the two limits", async () => {
    const query = vi.fn().mockResolvedValue({
      maxCameras: null,
      detectWeight: 70,
      decodeBudgetMb: 6000,
      maxLiveDecodeWorkers: 5,
    })
    const source = new NodeDecodeLimitsSource({ logger: logger(), nodeId: 'mac' })
    await source.refresh(apiReturning(query))
    expect(query).toHaveBeenCalledWith({ agentNodeId: 'mac' })
    expect(source.current()).toEqual({ decodeBudgetMb: 6000, maxLiveDecodeWorkers: 5 })
  })

  it('serves the cached value within the TTL, re-reads after it, and logs a change once', async () => {
    const log = logger()
    let now = 1_000
    const query = vi.fn().mockResolvedValue({ maxCameras: null, decodeBudgetMb: 6000 })
    const source = new NodeDecodeLimitsSource({
      logger: log,
      nodeId: 'mac',
      now: () => now,
      ttlMs: 30_000,
    })
    await source.refresh(apiReturning(query))
    await source.refresh(apiReturning(query))
    expect(query).toHaveBeenCalledTimes(1)
    now += 30_001
    await source.refresh(apiReturning(query))
    expect(query).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('a cleared limit is seen as cleared — null entry or absent key both mean "no override"', async () => {
    let now = 0
    const source = new NodeDecodeLimitsSource({
      logger: logger(),
      nodeId: 'mac',
      now: () => now,
      ttlMs: 1,
    })
    await source.refresh(
      apiReturning(vi.fn().mockResolvedValue({ maxCameras: null, decodeBudgetMb: 6000 })),
    )
    now += 10
    await source.refresh(apiReturning(vi.fn().mockResolvedValue({ maxCameras: null })))
    expect(source.current()).toEqual({})
    now += 10
    await source.refresh(apiReturning(vi.fn().mockResolvedValue(null)))
    expect(source.current()).toEqual({})
  })

  it('keeps the last known value when the read fails, and says so', async () => {
    const log = logger()
    let now = 0
    const source = new NodeDecodeLimitsSource({
      logger: log,
      nodeId: 'mac',
      now: () => now,
      ttlMs: 1,
    })
    await source.refresh(
      apiReturning(vi.fn().mockResolvedValue({ maxCameras: null, decodeBudgetMb: 6000 })),
    )
    now += 10
    await source.refresh(apiReturning(vi.fn().mockRejectedValue(new Error('hub down'))))
    expect(source.current()).toEqual({ decodeBudgetMb: 6000 })
    expect(log.warn).toHaveBeenCalledTimes(1)
    await source.refresh(undefined)
    expect(source.current()).toEqual({ decodeBudgetMb: 6000 })
  })
})
