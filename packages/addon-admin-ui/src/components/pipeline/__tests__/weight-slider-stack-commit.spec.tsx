/// <reference types="@testing-library/jest-dom" />

/**
 * Regression coverage for the commit-on-release contract.
 *
 * A prior fix for the "releasing one slider writes to ALL sliders with
 * random values" bug committed ONLY the dragged node — which stopped the
 * backend race but broke redistribution: the other (redistributed, or
 * locked) nodes' shares were never persisted, so the next server refetch
 * renormalised from a stale weight map and silently discarded both the
 * equal-redistribution and the lock.
 *
 * The correct contract: on release, `onCommitWeights` fires EXACTLY ONCE
 * with the full set of entries that must be persisted — every node whose
 * rounded share changed vs its last persisted weight, PLUS any locked node
 * (so a pinned share is always re-affirmed, never silently dropped). The
 * component itself does not race the backend: it hands the whole batch to
 * the caller in one call, and `PipelinePlacementBoard` (see
 * `PipelinePlacementBoard.tsx`) sequences the underlying
 * `setAgentDetectWeight` mutations with `await`, one at a time, so each
 * mutation reads the previous one's already-persisted result instead of
 * racing the backend's read-modify-write of the shared agent-settings map.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

import {
  WeightSliderStack,
  sharesFromNodes,
  type WeightCommitEntry,
  type WeightSliderNode,
} from '../placement-board/WeightSliderStack'

function node(id: string, name: string, weight: number): WeightSliderNode {
  return { id, name, weight }
}

describe('WeightSliderStack commit', () => {
  it('releasing one slider commits every node whose share changed, in ONE call', () => {
    const onCommitWeights = vi.fn()
    const nodes = [
      node('hub', 'Hub', 40),
      node('agent-1', 'Agent 1', 40),
      node('agent-2', 'Agent 2', 20),
    ]
    render(<WeightSliderStack nodes={nodes} pending={false} onCommitWeights={onCommitWeights} />)

    const hubSlider = screen.getByLabelText('Detection weight for Hub')
    fireEvent.change(hubSlider, { target: { value: '70' } })
    fireEvent.pointerUp(hubSlider)

    // Exactly one commit for the whole batch — never one call per node.
    expect(onCommitWeights).toHaveBeenCalledTimes(1)
    // hub -> 70 (dragged); the two unlocked others absorb the remaining 30
    // EQUALLY (15 each), not proportionally to their prior 40/20 shares.
    const entries: readonly WeightCommitEntry[] = onCommitWeights.mock.calls[0][0]
    expect(entries).toEqual([
      { nodeId: 'hub', weight: 70 },
      { nodeId: 'agent-1', weight: 15 },
      { nodeId: 'agent-2', weight: 15 },
    ])
  })

  it('committing via keyboard also fires once with the full changed set', () => {
    const onCommitWeights = vi.fn()
    const nodes = [node('hub', 'Hub', 50), node('agent-1', 'Agent 1', 50)]
    render(<WeightSliderStack nodes={nodes} pending={false} onCommitWeights={onCommitWeights} />)

    const agentSlider = screen.getByLabelText('Detection weight for Agent 1')
    fireEvent.change(agentSlider, { target: { value: '30' } })
    fireEvent.keyUp(agentSlider)

    expect(onCommitWeights).toHaveBeenCalledTimes(1)
    expect(onCommitWeights.mock.calls[0][0]).toEqual([
      { nodeId: 'hub', weight: 70 },
      { nodeId: 'agent-1', weight: 30 },
    ])
  })

  it("a locked node's share is preserved and included in the committed batch (total conserved at 100)", () => {
    const onCommitWeights = vi.fn()
    const nodes = [
      node('hub', 'Hub', 30),
      node('agent-1', 'Agent 1', 30),
      node('agent-2', 'Agent 2', 40),
    ]
    render(<WeightSliderStack nodes={nodes} pending={false} onCommitWeights={onCommitWeights} />)

    // Lock hub (first lock button in DOM order) before dragging agent-1.
    const lockButtons = screen.getAllByTitle('Lock this share when others change')
    fireEvent.click(lockButtons[0])

    const agentSlider = screen.getByLabelText('Detection weight for Agent 1')
    fireEvent.change(agentSlider, { target: { value: '50' } })
    fireEvent.pointerUp(agentSlider)

    expect(onCommitWeights).toHaveBeenCalledTimes(1)
    const entries: readonly WeightCommitEntry[] = onCommitWeights.mock.calls[0][0]
    // hub is locked and its rounded share (30) never changed from its
    // persisted weight, but it is still included — a locked share must
    // always be re-affirmed in the same batch as any change elsewhere, or a
    // partial commit could leave the persisted map inconsistent.
    expect(entries).toContainEqual({ nodeId: 'hub', weight: 30 })
    // agent-1 dragged to 50; the locked hub (30) holds a fixed slice of the
    // 100 budget, so the dragged slider + the sole unlocked other (agent-2)
    // share the remaining 100 - 30 = 70. agent-2 absorbs 70 - 50 = 20 and the
    // WHOLE batch conserves to 100 (never exceeds it).
    expect(entries).toContainEqual({ nodeId: 'agent-1', weight: 50 })
    expect(entries).toContainEqual({ nodeId: 'agent-2', weight: 20 })
    expect(entries).toHaveLength(3)
    expect(entries.reduce((s, e) => s + e.weight, 0)).toBe(100)

    // The locked slider itself stays disabled throughout.
    expect(screen.getByLabelText('Detection weight for Hub')).toBeDisabled()
  })

  it('OPERATOR BUG: locking A then dragging B never changes A — even after the committed weights round-trip back through sharesFromNodes', () => {
    const onCommitWeights = vi.fn()
    const nodes = [
      node('hub', 'Hub', 40),
      node('agent-1', 'Agent 1', 40),
      node('agent-2', 'Agent 2', 20),
    ]
    render(<WeightSliderStack nodes={nodes} pending={false} onCommitWeights={onCommitWeights} />)

    // Lock hub (A) at 40, then drag agent-1 (B).
    const lockButtons = screen.getAllByTitle('Lock this share when others change')
    fireEvent.click(lockButtons[0])

    const agentSlider = screen.getByLabelText('Detection weight for Agent 1')
    fireEvent.change(agentSlider, { target: { value: '55' } })
    fireEvent.pointerUp(agentSlider)

    const entries: readonly WeightCommitEntry[] = onCommitWeights.mock.calls[0][0]
    const committed = new Map(entries.map((e) => [e.nodeId, e.weight]))

    // 1) The locked node's committed weight is byte-for-byte its original 40.
    expect(committed.get('hub')).toBe(40)
    // 2) The whole persisted batch conserves to exactly 100 — this is what
    //    stops sharesFromNodes from re-scaling (shrinking) the locked node on
    //    the next refetch (the old "exceed-100 → normalise" bug).
    expect(entries.reduce((s, e) => s + e.weight, 0)).toBe(100)

    // 3) Simulate the server round-trip: the committed weights come back as the
    //    node set and are re-normalised. The locked A MUST still read 40.
    const refetched = nodes.map((n) => ({ ...n, weight: committed.get(n.id) ?? n.weight }))
    const reshares = sharesFromNodes(refetched)
    expect(reshares.hub).toBe(40) // locked A held — not 28.x as in the old model
  })

  it('does not commit anything when release leaves every share unchanged', () => {
    const onCommitWeights = vi.fn()
    const nodes = [node('hub', 'Hub', 50), node('agent-1', 'Agent 1', 50)]
    render(<WeightSliderStack nodes={nodes} pending={false} onCommitWeights={onCommitWeights} />)

    const hubSlider = screen.getByLabelText('Detection weight for Hub')
    // No drag — releasing without having changed anything must be a no-op.
    fireEvent.pointerUp(hubSlider)

    expect(onCommitWeights).not.toHaveBeenCalled()
  })
})
