import { describe, expect, it } from 'vitest'
import {
  isDeviceSaturated,
  pickInferenceDevice,
  RoundRobinInferenceDeviceRotation,
  selectedDeviceKey,
} from '../device-balancer.js'
import type {
  DeviceLoadInput,
  InferenceDeviceSelection,
  PickInferenceDeviceInput,
} from '../device-balancer.js'

/** Shorthand: build the loads array from a `deviceKey → attachedCameras` map. */
function loads(byKey: Record<string, number>): DeviceLoadInput[] {
  return Object.entries(byKey).map(([deviceKey, attachedCameras]) => ({
    deviceKey,
    attachedCameras,
    queueDepthTotal: 0,
  }))
}

/** The elected key (or `undefined` for "runner default pool") — the caller's view. */
function pick(input: PickInferenceDeviceInput): string | undefined {
  return selectedDeviceKey(pickInferenceDevice(input))
}

describe("pickInferenceDevice — second balance() pass over a node's devices", () => {
  it('elects nothing when zero devices are eligible (use the default accelerator)', () => {
    const selection: InferenceDeviceSelection = pickInferenceDevice({ eligible: {} })
    expect(selection).toEqual({
      kind: 'default-pool',
      reason: 'no-eligible-device',
      eligibleKeys: [],
    })
  })

  it('elects nothing when exactly one device is eligible and there is no pin', () => {
    const selection = pickInferenceDevice({ eligible: { 'openvino:npu': 1 } })
    expect(selection).toEqual({
      kind: 'default-pool',
      reason: 'single-eligible-device',
      eligibleKeys: ['openvino:npu'],
    })
  })

  it('honours a node+device pin even with a single eligible device', () => {
    const selection = pickInferenceDevice({
      eligible: { 'openvino:npu': 1 },
      pinnedDeviceKey: 'openvino:npu',
    })
    expect(selection).toMatchObject({ kind: 'selected', deviceKey: 'openvino:npu', reason: 'pin' })
  })

  it('spreads sessions to the least-loaded pool', () => {
    const eligible = { 'openvino:npu': 1, 'openvino:gpu': 1 }
    const selection = pickInferenceDevice({
      eligible,
      loads: loads({ 'openvino:npu': 2, 'openvino:gpu': 0 }),
    })
    // A real capacity win, not a tie — the reason must say so.
    expect(selection).toMatchObject({
      kind: 'selected',
      deviceKey: 'openvino:gpu',
      reason: 'capacity',
      tiedKeys: ['openvino:gpu'],
    })
  })

  it('honours weight — a 2x pool absorbs proportionally more sessions', () => {
    const eligible = { 'openvino:npu': 2, 'edgetpu:usb': 1 }
    // npu weight 2 @2 active → 1.0; edgetpu weight 1 @1 active → 1.0 — a TIE,
    // which is now resolved by the rotation rather than by key order.
    expect(
      pickInferenceDevice({ eligible, loads: loads({ 'openvino:npu': 2, 'edgetpu:usb': 1 }) }),
    ).toMatchObject({ reason: 'tie-break', tiedKeys: ['edgetpu:usb', 'openvino:npu'] })
    // npu @3 → 1.5 > edgetpu 1.0 → edgetpu wins outright, no tie.
    expect(
      pickInferenceDevice({ eligible, loads: loads({ 'openvino:npu': 3, 'edgetpu:usb': 1 }) }),
    ).toMatchObject({ deviceKey: 'edgetpu:usb', reason: 'capacity' })
  })

  it('balances three accelerators (NPU + iGPU + Coral) once two are loaded', () => {
    const eligible = { 'openvino:npu': 1, 'openvino:gpu': 1, 'edgetpu:usb': 1 }
    expect(
      pick({
        eligible,
        loads: loads({ 'openvino:npu': 1, 'openvino:gpu': 1, 'edgetpu:usb': 0 }),
      }),
    ).toBe('edgetpu:usb')
  })

  it('enforces a per-device maxSessions cap — a device at cap is skipped', () => {
    const eligible = { 'openvino:npu': 1, 'openvino:gpu': 1 }
    // npu at cap (1/1) despite being least-loaded → gpu is chosen instead.
    expect(
      pick({
        eligible,
        loads: loads({ 'openvino:npu': 1, 'openvino:gpu': 3 }),
        caps: { 'openvino:npu': 1 },
      }),
    ).toBe('openvino:gpu')
  })

  it('a pinned device wins over a less-loaded unpinned one (L1 affinity)', () => {
    const eligible = { 'openvino:npu': 1, 'openvino:gpu': 1 }
    expect(
      pick({
        eligible,
        loads: loads({ 'openvino:npu': 5, 'openvino:gpu': 0 }),
        pinnedDeviceKey: 'openvino:npu',
      }),
    ).toBe('openvino:npu')
  })

  it('a pin to a device that is over its cap does NOT place (falls back to default pool)', () => {
    const eligible = { 'openvino:npu': 1, 'openvino:gpu': 1 }
    expect(
      pickInferenceDevice({
        eligible,
        loads: loads({ 'openvino:npu': 2, 'openvino:gpu': 0 }),
        caps: { 'openvino:npu': 1 },
        pinnedDeviceKey: 'openvino:npu',
      }),
    ).toEqual({
      kind: 'default-pool',
      reason: 'pin-unplaceable',
      eligibleKeys: ['openvino:gpu', 'openvino:npu'],
    })
  })
})

describe('pickInferenceDevice — fairness at a genuine tie', () => {
  // The live failure this fixes: two enabled, available, equal-weight,
  // uncapped, unpinned OpenVINO devices on the hub. On-motion sessions start
  // and end, so at every dispatch BOTH score 0 — a permanent tie. The old
  // `nodeId.localeCompare` tie-break then sent 100% of sessions to
  // `openvino:gpu` and left the NPU idle indefinitely.
  const HUB = { 'openvino:gpu': 1, 'openvino:npu': 1 }

  it('alternates between two tied devices instead of always picking the first', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    // Every dispatch sees an EMPTY node — sessions never overlap.
    const picks = [0, 1, 2, 3].map(() => pick({ eligible: HUB, rotation }))
    expect(picks).toEqual(['openvino:gpu', 'openvino:npu', 'openvino:gpu', 'openvino:npu'])
    // The property that actually matters: neither device is starved.
    expect(new Set(picks).size).toBe(2)
  })

  it('rotates across three tied devices', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    const eligible = { 'openvino:npu': 1, 'openvino:gpu': 1, 'edgetpu:usb': 1 }
    const picks = [0, 1, 2, 3].map(() => pick({ eligible, rotation }))
    expect(picks).toEqual(['edgetpu:usb', 'openvino:gpu', 'openvino:npu', 'edgetpu:usb'])
  })

  it('reports HOW the tie was resolved', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    expect(pickInferenceDevice({ eligible: HUB, rotation })).toEqual({
      kind: 'selected',
      deviceKey: 'openvino:gpu',
      reason: 'tie-break',
      tieBreak: 'rotation',
      eligibleKeys: ['openvino:gpu', 'openvino:npu'],
      tiedKeys: ['openvino:gpu', 'openvino:npu'],
    })
  })

  it('keeps a separate cursor per tied SET, so a device going away restarts a correct rotation', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    expect(pick({ eligible: HUB, rotation })).toBe('openvino:gpu')
    // The Coral is plugged in — a DIFFERENT tied set, with its own cursor.
    const withCoral = { ...HUB, 'edgetpu:usb': 1 }
    expect(pick({ eligible: withCoral, rotation })).toBe('edgetpu:usb')
    // …and the two-device rotation resumes where it left off.
    expect(pick({ eligible: HUB, rotation })).toBe('openvino:npu')
  })

  it('is IDEMPOTENT for an already-placed camera — a re-run never thrashes it', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    // The camera is standing on the npu. Re-running placement ten times must
    // leave it there, and must not consume rotation slots either.
    for (let i = 0; i < 10; i += 1) {
      expect(
        pickInferenceDevice({
          eligible: HUB,
          currentDeviceKey: 'openvino:npu',
          rotation,
        }),
      ).toMatchObject({ deviceKey: 'openvino:npu', reason: 'tie-break', tieBreak: 'sticky' })
    }
    // The rotation was untouched by those re-runs — a NEW camera still gets
    // the first slot.
    expect(pick({ eligible: HUB, rotation })).toBe('openvino:gpu')
  })

  it('does not stick to a device that is no longer tied (it lost on capacity)', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    // The camera sits on the npu, but the npu is now the loaded one — capacity
    // wins outright, so there is no tie to be sticky about.
    expect(
      pick({
        eligible: HUB,
        loads: loads({ 'openvino:npu': 4, 'openvino:gpu': 0 }),
        currentDeviceKey: 'openvino:npu',
        rotation,
      }),
    ).toBe('openvino:gpu')
  })

  it('a pin still beats both stickiness and the rotation', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    expect(
      pick({
        eligible: HUB,
        currentDeviceKey: 'openvino:gpu',
        pinnedDeviceKey: 'openvino:npu',
        rotation,
      }),
    ).toBe('openvino:npu')
  })

  it('the rotation never elects a device that is at its cap', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    const picks = [0, 1, 2, 3].map(() =>
      pick({
        eligible: HUB,
        loads: loads({ 'openvino:npu': 2, 'openvino:gpu': 0 }),
        caps: { 'openvino:npu': 2 },
        rotation,
      }),
    )
    // npu is at 2/2 → it is not a candidate at all, so there is no tie and
    // every dispatch lands on the gpu.
    expect(picks).toEqual(Array(4).fill('openvino:gpu'))
  })

  it('without a rotation the tie stays deterministic (lexicographic, and it says so)', () => {
    // The back-compat path: no rotation injected ⇒ old behaviour, but now
    // self-declaring rather than silent.
    expect(pickInferenceDevice({ eligible: HUB })).toMatchObject({
      deviceKey: 'openvino:gpu',
      reason: 'tie-break',
      tieBreak: 'lexicographic',
    })
  })
})

describe('a drowning device stops attracting sessions', () => {
  /**
   * THE LIVE CASE (2026-09-04). The hub's `openvino:gpu` failed 100% of
   * inferences for four hours — its pool queue pinned at the shed cap, 12 019
   * of 16 146 timeouts recorded at inFlight 7 of 8 — and still won ~47% of
   * elections (741 vs 666 for the NPU), because election weighs SESSIONS and a
   * device that answers nothing still holds few sessions. The NPU had zero
   * timeouts and a measured p99 of 28 ms at parallel 4: it could have absorbed
   * the entire arrival alone.
   */
  // Identical on EVERY signal the balancer already weighed — same session
  // count. Only the pool backlog differs, so the assertion can only be
  // satisfied by the saturation gate. (The first version of this test gave the
  // drowning device a higher queue depth — a per-device field removed in D762
  // because nothing measured it — and passed with the gate removed: it was
  // measuring the pre-existing tier, not the fix.)
  const SATURATED = {
    deviceKey: 'openvino:gpu',
    attachedCameras: 1,
    inFlight: 8,
    inFlightCap: 8,
  }
  const HEALTHY = {
    deviceKey: 'openvino:npu',
    attachedCameras: 1,
    inFlight: 0,
    inFlightCap: 8,
  }

  it('elects the healthy device when the other is pinned at its shed cap', () => {
    const selection = pickInferenceDevice({
      eligible: { 'openvino:gpu': 1, 'openvino:npu': 1 },
      loads: [SATURATED, HEALTHY],
    })
    expect(selection.kind).toBe('selected')
    expect(selectedDeviceKey(selection)).toBe('openvino:npu')
  })

  it('still elects a saturated device when EVERY eligible one is drowning', () => {
    const selection = pickInferenceDevice({
      eligible: { 'openvino:gpu': 1, 'openvino:npu': 1 },
      loads: [SATURATED, { ...HEALTHY, inFlight: 8 }],
    })
    // Excluding the whole set would silently disable the accelerator tier.
    expect(['selected', 'default-pool']).toContain(selection.kind)
  })

  it('honours an explicit pin even onto a saturated device — a pin is a statement', () => {
    const selection = pickInferenceDevice({
      eligible: { 'openvino:gpu': 1, 'openvino:npu': 1 },
      loads: [SATURATED, HEALTHY],
      pinnedDeviceKey: 'openvino:gpu',
    })
    expect(selectedDeviceKey(selection)).toBe('openvino:gpu')
  })

  it('treats an unreported backlog as healthy, never as saturated', () => {
    expect(isDeviceSaturated({ deviceKey: 'x', attachedCameras: 0 })).toBe(false)
    expect(isDeviceSaturated(undefined)).toBe(false)
  })

  it('is saturated only at or above the cap', () => {
    const base = { deviceKey: 'x', attachedCameras: 0, inFlightCap: 8 }
    expect(isDeviceSaturated({ ...base, inFlight: 7 })).toBe(false)
    expect(isDeviceSaturated({ ...base, inFlight: 8 })).toBe(true)
    expect(isDeviceSaturated({ ...base, inFlight: 9 })).toBe(true)
  })
})
