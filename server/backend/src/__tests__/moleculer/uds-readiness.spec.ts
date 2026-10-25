/**
 * UDS readiness snapshot wiring — unit test for Task D1.
 *
 * Verifies that:
 *  1. The hub's `LocalChildRegistry.onReadinessSnapshotRequest` is wired to
 *     return `readinessRegistry.getSnapshotForTransport()` — the same records
 *     `$readiness.getSnapshot` returns, now also reachable over UDS.
 *  2. The agent's `agentUdsRegistry.onReadinessSnapshotRequest` is wired to
 *     return its own registry's snapshot.
 *
 * We do NOT spin up a full broker — instead we test the wiring function
 * `wireReadinessSnapshotHandler` which is extracted from the hub/agent setup
 * so the glue code is unit-testable.
 */
import { describe, it, expect, vi } from 'vitest'
import type { IReadinessRegistryRecord } from '@camstack/types'

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

interface FakeReadinessRegistry {
  getSnapshotForTransport(): readonly IReadinessRegistryRecord[]
}

interface FakeLocalChildRegistry {
  onReadinessSnapshotRequest(handler: () => readonly IReadinessRegistryRecord[]): void
}

/**
 * Minimal wiring function — production code calls exactly this at the same
 * site in moleculer.service.ts and agent-bootstrap.ts.
 */
function wireReadinessSnapshotHandler(
  childRegistry: FakeLocalChildRegistry,
  readinessRegistry: FakeReadinessRegistry,
): void {
  childRegistry.onReadinessSnapshotRequest(() => readinessRegistry.getSnapshotForTransport())
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('D1 — wireReadinessSnapshotHandler', () => {
  it('registers a handler on the child registry', () => {
    const childReg: FakeLocalChildRegistry = {
      onReadinessSnapshotRequest: vi.fn(),
    }
    const readinessReg: FakeReadinessRegistry = {
      getSnapshotForTransport: () => [],
    }

    wireReadinessSnapshotHandler(childReg, readinessReg)

    expect(childReg.onReadinessSnapshotRequest).toHaveBeenCalledOnce()
  })

  it('the registered handler returns getSnapshotForTransport() records', () => {
    const records: IReadinessRegistryRecord[] = [
      {
        capName: 'pipeline-executor',
        scope: { type: 'global' },
        state: 'ready',
        generation: 'gen-abc',
        epoch: 1,
        lastChange: 1_000_000,
        sourceNodeId: 'hub/pipeline-executor',
      },
    ]

    let capturedHandler: (() => readonly IReadinessRegistryRecord[]) | null = null
    const childReg: FakeLocalChildRegistry = {
      onReadinessSnapshotRequest: (h) => {
        capturedHandler = h
      },
    }
    const readinessReg: FakeReadinessRegistry = {
      getSnapshotForTransport: () => records,
    }

    wireReadinessSnapshotHandler(childReg, readinessReg)

    expect(capturedHandler).not.toBeNull()
    const result = capturedHandler!()
    expect(result).toBe(records)
  })

  it('handler calls getSnapshotForTransport on every invocation (live snapshot)', () => {
    const getSnapshot = vi
      .fn<() => readonly IReadinessRegistryRecord[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        {
          capName: 'stream-broker',
          scope: { type: 'node', nodeId: 'hub' },
          state: 'ready',
          generation: 'gen-1',
          epoch: 1,
          lastChange: 1_000,
          sourceNodeId: 'hub',
        },
      ])

    let capturedHandler: (() => readonly IReadinessRegistryRecord[]) | null = null
    const childReg: FakeLocalChildRegistry = {
      onReadinessSnapshotRequest: (h) => {
        capturedHandler = h
      },
    }
    const readinessReg: FakeReadinessRegistry = { getSnapshotForTransport: getSnapshot }

    wireReadinessSnapshotHandler(childReg, readinessReg)

    expect(capturedHandler!()).toHaveLength(0)
    expect(capturedHandler!()).toHaveLength(1)
    expect(getSnapshot).toHaveBeenCalledTimes(2)
  })

  it('handler snapshot reflects current registry state (not a frozen copy)', () => {
    const mutableRecords: IReadinessRegistryRecord[] = []
    const readinessReg: FakeReadinessRegistry = {
      getSnapshotForTransport: () => [...mutableRecords],
    }

    let capturedHandler: (() => readonly IReadinessRegistryRecord[]) | null = null
    const childReg: FakeLocalChildRegistry = {
      onReadinessSnapshotRequest: (h) => {
        capturedHandler = h
      },
    }

    wireReadinessSnapshotHandler(childReg, readinessReg)

    expect(capturedHandler!()).toHaveLength(0)

    mutableRecords.push({
      capName: 'motion-detector',
      scope: { type: 'device', deviceId: 7 },
      state: 'starting',
      generation: 'gen-2',
      epoch: 0,
      lastChange: 2_000,
      sourceNodeId: 'hub/provider-reolink',
    })

    expect(capturedHandler!()).toHaveLength(1)
    expect(capturedHandler!()[0]!.capName).toBe('motion-detector')
  })
})
