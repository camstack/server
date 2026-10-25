/**
 * "Stop choosing the dead accelerator" — the routing half of the 2026-08-25
 * blackout.
 *
 * The hub's `openvino:gpu` Python worker was SIGABRT'd 1.3 s after `Pool ready`
 * and stayed dead for 31 hours. The hardware was present the whole time, the
 * node's NPU was healthy the whole time, and the per-dispatch capability gate
 * is keyed on model FORMAT — which `openvino:gpu` and `openvino:npu` share — so
 * every routing decision in the system was structurally blind to the corpse.
 * The balancer kept feeding it by rotation: 20 sessions in 20 minutes, ~370 000
 * lost frames.
 *
 * These tests pin the properties the fix rests on, one per behaviour:
 *  1. a refused device leaves the balancer's candidate set;
 *  2. a HEALTHY device is never excluded by a single suspicious observation;
 *  3. a failed read changes nothing at all (D49);
 *  4. re-admission is immediate;
 *  5. a node whose every accelerator pool is dead is refused LOUDLY rather than
 *     silently demoted onto its CPU.
 */
import { describe, expect, it } from 'vitest'
import type { InferenceDeviceDescriptor } from '@camstack/types'
import {
  resolveInferenceDeviceEligibility,
  resolveNodeInferenceUsability,
  type StoredInferenceDevice,
} from '../inference-device-model.js'
import {
  foldInferenceDeviceHealth,
  InferenceDeviceUsabilityMirror,
} from '../inference-device-usability-mirror.js'

const HUB = 'hub'

function probed(key: string, available = true): InferenceDeviceDescriptor {
  const [backend = 'openvino', device = 'npu'] = key.split(':')
  return { key, backend, device, format: 'openvino', runtime: 'python', score: 1, available }
}

/** The hub as it actually was: an NPU and an iGPU, both present, both enabled. */
const HUB_PROBE: readonly InferenceDeviceDescriptor[] = [
  probed('openvino:gpu'),
  probed('openvino:npu'),
]
const NO_STORED: Record<string, StoredInferenceDevice> = {}

function eligibleKeys(
  mirror: InferenceDeviceUsabilityMirror,
  probe: readonly InferenceDeviceDescriptor[] = HUB_PROBE,
  stored: Record<string, StoredInferenceDevice> = NO_STORED,
): readonly string[] {
  return Object.keys(
    resolveInferenceDeviceEligibility(probe, stored, undefined, (deviceKey) =>
      mirror.isUsable(HUB, deviceKey),
    ).eligible,
  ).toSorted()
}

/**
 * One health answer, folded in by the SAME function the orchestrator calls —
 * not a restatement of it. A local reimplementation here would be a fake that
 * supplies the discipline production forgot, and the first draft of this file
 * proved the point: its copy observed only the refused devices, which silently
 * broke "consecutive", and the copy would have passed on production code that
 * did the same.
 */
function observe(
  mirror: InferenceDeviceUsabilityMirror,
  unhealthy: readonly string[] | null,
  present: readonly InferenceDeviceDescriptor[] = HUB_PROBE,
): void {
  foldInferenceDeviceHealth(
    mirror,
    HUB,
    unhealthy,
    present.map((d) => d.key),
  )
}

describe('the dead accelerator leaves the balancer candidate set', () => {
  it('is still chosen after ONE bad observation — exclusion is armed, not applied', () => {
    const mirror = new InferenceDeviceUsabilityMirror()
    observe(mirror, ['openvino:gpu'])
    expect(eligibleKeys(mirror)).toEqual(['openvino:gpu', 'openvino:npu'])
  })

  it('is dropped on the SECOND consecutive bad observation, and only it', () => {
    const mirror = new InferenceDeviceUsabilityMirror()
    observe(mirror, ['openvino:gpu'])
    observe(mirror, ['openvino:gpu'])
    // The healthy NPU on the same node, same backend, same FORMAT, survives —
    // which is the whole point: the capability gate could never do this.
    expect(eligibleKeys(mirror)).toEqual(['openvino:npu'])
  })

  it('is reported as `unavailable`, the reason the node tier already counts', () => {
    const mirror = new InferenceDeviceUsabilityMirror()
    observe(mirror, ['openvino:gpu'])
    observe(mirror, ['openvino:gpu'])
    const { excluded } = resolveInferenceDeviceEligibility(
      HUB_PROBE,
      NO_STORED,
      undefined,
      (deviceKey) => mirror.isUsable(HUB, deviceKey),
    )
    expect(excluded).toEqual([{ key: 'openvino:gpu', reason: 'unavailable', format: 'openvino' }])
  })
})

describe('a healthy device is never excluded by one suspicious read (D49)', () => {
  it('a bad observation followed by a good one leaves the device in play', () => {
    const mirror = new InferenceDeviceUsabilityMirror()
    observe(mirror, ['openvino:gpu'])
    observe(mirror, []) // the pool answered — nothing is refused
    observe(mirror, ['openvino:gpu']) // a fresh arm, not the second of a pair
    expect(eligibleKeys(mirror)).toEqual(['openvino:gpu', 'openvino:npu'])
  })

  it('a FAILED read changes nothing — it can neither exclude nor re-admit', () => {
    const mirror = new InferenceDeviceUsabilityMirror()
    // Two failed reads in a row must not do what two bad reads would do.
    observe(mirror, null)
    observe(mirror, null)
    expect(eligibleKeys(mirror)).toEqual(['openvino:gpu', 'openvino:npu'])

    // And once a device IS excluded, failed reads must not resurrect it: a
    // rejected RPC looks exactly like "nothing is refused" if the two are
    // collapsed, and that is how a dead accelerator gets fed again.
    observe(mirror, ['openvino:gpu'])
    observe(mirror, ['openvino:gpu'])
    expect(eligibleKeys(mirror)).toEqual(['openvino:npu'])
    observe(mirror, null)
    observe(mirror, null)
    expect(eligibleKeys(mirror)).toEqual(['openvino:npu'])
  })

  it('two bad reads far apart do NOT add up — the good reads between them count', () => {
    // The property "consecutive" only exists if the good observations are
    // actually DELIVERED. A fold that observes only the refused devices never
    // disarms a device it has armed, so a bad read on Monday and a bad read on
    // Friday exclude a healthy accelerator with a week of clean reads between.
    const mirror = new InferenceDeviceUsabilityMirror()
    observe(mirror, ['openvino:gpu'])
    for (let clean = 0; clean < 100; clean++) observe(mirror, [])
    observe(mirror, ['openvino:gpu'])
    expect(eligibleKeys(mirror)).toEqual(['openvino:gpu', 'openvino:npu'])
  })

  it('a device never observed at all is usable — absence of evidence is not evidence', () => {
    expect(eligibleKeys(new InferenceDeviceUsabilityMirror())).toEqual([
      'openvino:gpu',
      'openvino:npu',
    ])
  })
})

describe('re-entry', () => {
  it('ONE good observation re-admits an excluded device immediately', () => {
    const mirror = new InferenceDeviceUsabilityMirror()
    observe(mirror, ['openvino:gpu'])
    observe(mirror, ['openvino:gpu'])
    expect(eligibleKeys(mirror)).toEqual(['openvino:npu'])
    observe(mirror, [])
    expect(eligibleKeys(mirror)).toEqual(['openvino:gpu', 'openvino:npu'])
  })

  it('the excluded set is enumerable per node — a terminal state must be visible', () => {
    const mirror = new InferenceDeviceUsabilityMirror()
    observe(mirror, ['openvino:gpu'])
    observe(mirror, ['openvino:gpu'])
    expect(mirror.unusableDeviceKeys(HUB)).toEqual(['openvino:gpu'])
    expect(mirror.unusableDeviceKeys('agent-a')).toEqual([])
  })

  it('two nodes with the same deviceKey are independent', () => {
    // `openvino:gpu` is dead on the hub and healthy on agent-a; a mirror
    // keyed on deviceKey alone would strand the working iGPU on the other node.
    const mirror = new InferenceDeviceUsabilityMirror()
    mirror.observe(HUB, 'openvino:gpu', false)
    mirror.observe(HUB, 'openvino:gpu', false)
    expect(mirror.isUsable(HUB, 'openvino:gpu')).toBe(false)
    expect(mirror.isUsable('agent-a', 'openvino:gpu')).toBe(true)
  })
})

describe('nothing healthy left on the node', () => {
  it('every accelerator pool dead ⇒ the NODE is unusable, not quietly demoted to CPU', () => {
    // Refusing loudly beats degrading silently: the node leaves the placement
    // candidate set (the existing node tier fires its event), and its cameras
    // go to a node whose accelerators still work. Promoting the CPU here would
    // keep the node absorbing cameras forever on a fallback D215 measured at
    // 44% of dispatches and 647% CPU — and the healthy iGPU on agent-a
    // would never be used.
    const mirror = new InferenceDeviceUsabilityMirror()
    for (const round of [0, 1]) {
      void round
      observe(mirror, ['openvino:gpu', 'openvino:npu'])
    }
    const probe = [...HUB_PROBE, probed('cpu:0')]
    const eligibility = resolveInferenceDeviceEligibility(
      probe,
      { 'cpu:0': { enabled: true } },
      undefined,
      (deviceKey) => mirror.isUsable(HUB, deviceKey),
    )
    expect(Object.keys(eligibility.eligible)).toEqual([])
    const usability = resolveNodeInferenceUsability(eligibility)
    expect(usability.usable).toBe(false)
    expect(usability.unavailableKeys).toEqual(['openvino:gpu', 'openvino:npu'])
  })

  it('ONE surviving accelerator keeps the node usable — no over-reaction', () => {
    const mirror = new InferenceDeviceUsabilityMirror()
    observe(mirror, ['openvino:gpu'])
    observe(mirror, ['openvino:gpu'])
    const usability = resolveNodeInferenceUsability(
      resolveInferenceDeviceEligibility(HUB_PROBE, NO_STORED, undefined, (deviceKey) =>
        mirror.isUsable(HUB, deviceKey),
      ),
    )
    expect(usability.usable).toBe(true)
    expect(usability.eligibleKeys).toEqual(['openvino:npu'])
  })
})
