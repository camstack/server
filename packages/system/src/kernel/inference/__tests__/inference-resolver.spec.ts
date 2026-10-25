import { describe, expect, it } from 'vitest'
import type { CoralInfo } from '@camstack/types'
import { mapSignalsToInferenceHardware } from '../inference-resolver.js'
import type { PlatformSignals } from '../../hwaccel/hwaccel-resolver.js'

function signals(over: Partial<PlatformSignals> = {}): PlatformSignals {
  return {
    platform: 'linux',
    arch: 'x64',
    hasNvidiaGpu: false,
    hasAmdGpu: false,
    hasIntelGpu: false,
    hasRenderNode: false,
    hasIntelNpu: false,
    coral: null,
    ...over,
  }
}

describe('mapSignalsToInferenceHardware', () => {
  it('nvidia gpu → gpu.type nvidia', () => {
    expect(
      mapSignalsToInferenceHardware(signals({ hasNvidiaGpu: true, hasRenderNode: true })),
    ).toEqual({ gpu: { type: 'nvidia' }, npu: null, coral: null })
  })

  it('intel gpu (or render node) → gpu.type intel', () => {
    expect(
      mapSignalsToInferenceHardware(signals({ hasIntelGpu: true, hasRenderNode: true })),
    ).toEqual({ gpu: { type: 'intel' }, npu: null, coral: null })
    expect(mapSignalsToInferenceHardware(signals({ hasRenderNode: true }))).toEqual({
      gpu: { type: 'intel' },
      npu: null,
      coral: null,
    })
  })

  it('amd gpu wins over render-node fallback (Phoenix)', () => {
    expect(
      mapSignalsToInferenceHardware(signals({ hasAmdGpu: true, hasRenderNode: true })),
    ).toEqual({ gpu: { type: 'amd' }, npu: null, coral: null })
  })

  it('darwin arm64 → npu.type apple-ane', () => {
    expect(mapSignalsToInferenceHardware(signals({ platform: 'darwin', arch: 'arm64' }))).toEqual({
      gpu: null,
      npu: { type: 'apple-ane' },
      coral: null,
    })
  })

  it('intel npu (Meteor Lake / Core Ultra) → npu.type intel-npu', () => {
    expect(mapSignalsToInferenceHardware(signals({ hasIntelNpu: true }))).toEqual({
      gpu: null,
      npu: { type: 'intel-npu' },
      coral: null,
    })
  })

  it('intel iGPU + NPU (the hub) → gpu intel AND npu intel-npu', () => {
    expect(
      mapSignalsToInferenceHardware(
        signals({ hasIntelGpu: true, hasRenderNode: true, hasIntelNpu: true }),
      ),
    ).toEqual({ gpu: { type: 'intel' }, npu: { type: 'intel-npu' }, coral: null })
  })

  it('a Coral (USB or PCIe) passes through WHOLE — its units and reasons reach the enumerator', () => {
    const pci: CoralInfo = { type: 'coral-edgetpu', units: [{ bus: 'pci', count: 2 }] }
    expect(mapSignalsToInferenceHardware(signals({ coral: pci }))).toEqual({
      gpu: null,
      npu: null,
      coral: pci,
    })
    // The hub carries an Intel iGPU + NPU AND a USB Coral — all three surface.
    const usb: CoralInfo = { type: 'coral-edgetpu', units: [{ bus: 'usb', count: 1 }] }
    expect(
      mapSignalsToInferenceHardware(
        signals({ hasIntelGpu: true, hasRenderNode: true, hasIntelNpu: true, coral: usb }),
      ),
    ).toEqual({ gpu: { type: 'intel' }, npu: { type: 'intel-npu' }, coral: usb })
  })

  it('a present-but-driverless PCIe Coral is reported, not dropped', () => {
    const missing: CoralInfo = {
      type: 'coral-edgetpu',
      units: [],
      unavailable: [{ bus: 'pci', count: 2, reason: 'driver-missing' }],
    }
    expect(mapSignalsToInferenceHardware(signals({ coral: missing })).coral).toEqual(missing)
  })

  it('apple-ane wins over an (impossible) intel-npu signal on darwin', () => {
    expect(
      mapSignalsToInferenceHardware(
        signals({ platform: 'darwin', arch: 'arm64', hasIntelNpu: true }),
      ),
    ).toEqual({ gpu: null, npu: { type: 'apple-ane' }, coral: null })
  })

  it('no accelerator → all null', () => {
    expect(mapSignalsToInferenceHardware(signals())).toEqual({ gpu: null, npu: null, coral: null })
  })
})
