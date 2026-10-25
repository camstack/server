/**
 * "This node cannot infer any more" — the predicate, and the reluctance.
 *
 * agent-a absorbed 283 000 inference errors in one day while still being
 * handed cameras. These tests pin BOTH halves of the fix: the predicate that
 * separates that state from a perfectly healthy CPU-only node, and the mirror
 * that refuses to act on a single bad read.
 */
import { describe, expect, it } from 'vitest'
import {
  resolveInferenceDeviceEligibility,
  resolveNodeInferenceUsability,
} from '../inference-device-model.js'
import { NodeInferenceUsabilityMirror } from '../node-inference-usability-mirror.js'
import type { InferenceDeviceDescriptor } from '@camstack/types'
import type { StoredInferenceDevice } from '../inference-device-model.js'

function probed(key: string, available = true): InferenceDeviceDescriptor {
  const [backend = 'cuda', device = '0'] = key.split(':')
  return {
    key,
    backend,
    device,
    format: 'onnx',
    runtime: 'python',
    score: 1,
    available,
  }
}

function usabilityOf(
  probe: readonly InferenceDeviceDescriptor[],
  stored: Record<string, StoredInferenceDevice>,
): ReturnType<typeof resolveNodeInferenceUsability> {
  return resolveNodeInferenceUsability(resolveInferenceDeviceEligibility(probe, stored))
}

describe('resolveNodeInferenceUsability — what "unusable" means', () => {
  it('a node with a live accelerator is usable', () => {
    expect(usabilityOf([probed('cuda:0')], {}).usable).toBe(true)
  })

  it('a CPU-ONLY node with nothing configured is USABLE — the common install', () => {
    // cpu/edgetpu are opt-IN, so they are excluded as `disabled`, not
    // `unavailable`. Treating zero eligible devices as a veto would empty the
    // cluster on every default install.
    const u = usabilityOf([probed('cpu:0')], {})
    expect(u.eligibleKeys).toEqual([])
    expect(u.usable).toBe(true)
  })

  it('a node whose only accelerator the operator DISABLED is still usable', () => {
    // The runner's default CPU pool serves it, exactly as before.
    expect(usabilityOf([probed('cuda:0')], { 'cuda:0': { enabled: false } }).usable).toBe(true)
  })

  it('a node whose enabled accelerator VANISHED is unusable — the 283k-error state', () => {
    // Stored (so the operator enabled it) and not reported by the live probe.
    const u = usabilityOf([], { 'cuda:0': { enabled: true } })
    expect(u.usable).toBe(false)
    expect(u.unavailableKeys).toEqual(['cuda:0'])
  })

  it('one surviving accelerator is enough to stay usable', () => {
    const u = usabilityOf([probed('cuda:0')], {
      'cuda:0': { enabled: true },
      'cuda:1': { enabled: true },
    })
    expect(u.eligibleKeys).toEqual(['cuda:0'])
    expect(u.usable).toBe(true)
  })
})

describe('NodeInferenceUsabilityMirror — reluctance in the destructive direction', () => {
  it('an unobserved node is usable', () => {
    expect(new NodeInferenceUsabilityMirror().isUsable('agent-a')).toBe(true)
  })

  it('ONE bad observation does not exclude a node', () => {
    const m = new NodeInferenceUsabilityMirror()
    m.observe('n', true)
    expect(m.observe('n', false)).toBeNull()
    expect(m.isUsable('n')).toBe(true)
  })

  it('TWO consecutive bad observations exclude it, and say so once', () => {
    const m = new NodeInferenceUsabilityMirror()
    m.observe('n', true)
    m.observe('n', false)
    expect(m.observe('n', false)).toBe('became-unusable')
    expect(m.isUsable('n')).toBe(false)
    // ...and never repeats while it holds.
    expect(m.observe('n', false)).toBeNull()
    expect(m.observe('n', false)).toBeNull()
  })

  it('a good observation between two bad ones DISARMS — a blip is not an outage', () => {
    const m = new NodeInferenceUsabilityMirror()
    m.observe('n', true)
    m.observe('n', false)
    expect(m.observe('n', true)).toBeNull()
    expect(m.observe('n', false)).toBeNull()
    expect(m.isUsable('n')).toBe(true)
  })

  it('a node whose FIRST ever observation is bad is armed, not excluded', () => {
    const m = new NodeInferenceUsabilityMirror()
    expect(m.observe('n', false)).toBeNull()
    expect(m.isUsable('n')).toBe(true)
  })

  it('recovery is immediate and unconditional — one good read is enough', () => {
    const m = new NodeInferenceUsabilityMirror()
    m.observe('n', true)
    m.observe('n', false)
    m.observe('n', false)
    expect(m.isUsable('n')).toBe(false)
    expect(m.observe('n', true)).toBe('recovered')
    expect(m.isUsable('n')).toBe(true)
  })

  it('lists the excluded nodes for the placement log', () => {
    const m = new NodeInferenceUsabilityMirror()
    for (const n of ['b', 'a']) {
      m.observe(n, true)
      m.observe(n, false)
      m.observe(n, false)
    }
    m.observe('c', true)
    expect(m.unusableNodeIds()).toEqual(['a', 'b'])
  })

  it('forget() drops a node entirely (it goes back to usable-unknown)', () => {
    const m = new NodeInferenceUsabilityMirror()
    m.observe('n', true)
    m.observe('n', false)
    m.observe('n', false)
    m.forget('n')
    expect(m.isUsable('n')).toBe(true)
  })
})
