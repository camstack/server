import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../../interfaces/platform.js'
import { coralUsableUnits, edgetpuDelegateDevice } from '../coral-units.js'
import {
  enumerateInferenceDevices,
  runtimeDevices,
  scoreRuntimes,
  supportedRuntimes,
} from '../runtime-capabilities.js'

const amdNode: HardwareInfo = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'AMD Ryzen 7 8845HS',
  cpuCores: 16,
  totalRAM_MB: 32000,
  availableRAM_MB: 24000,
  gpu: { type: 'amd', name: 'Radeon 780M' },
  npu: null,
  coral: null,
}

function edgeKeys(hw: HardwareInfo): readonly string[] {
  return enumerateInferenceDevices(hw)
    .filter((d) => d.backend === 'edgetpu')
    .map((d) => d.key)
}

describe('coralUsableUnits', () => {
  it('reads a legacy single-bus report (no units) as USB units', () => {
    expect(coralUsableUnits({ type: 'coral-edgetpu', bus: 'usb', count: 2 })).toEqual([
      { bus: 'usb', index: 0, device: 'usb' },
      { bus: 'usb', index: 1, device: 'usb:1' },
    ])
    expect(coralUsableUnits({ type: 'coral-edgetpu', bus: 'usb' })).toEqual([
      { bus: 'usb', index: 0, device: 'usb' },
    ])
  })

  it('has no usable unit when every PCI unit is unavailable', () => {
    expect(
      coralUsableUnits({
        type: 'coral-edgetpu',
        units: [],
        unavailable: [{ bus: 'pci', count: 2, reason: 'driver-missing' }],
      }),
    ).toEqual([])
    expect(coralUsableUnits(null)).toEqual([])
  })
})

describe('edgetpu device keys over PCIe and USB', () => {
  it('two PCIe units → edgetpu:pci, edgetpu:pci:1', () => {
    const hw: HardwareInfo = {
      ...amdNode,
      coral: { type: 'coral-edgetpu', units: [{ bus: 'pci', count: 2 }] },
    }
    expect(edgeKeys(hw)).toEqual(['edgetpu:pci', 'edgetpu:pci:1'])
    const second = enumerateInferenceDevices(hw).find((d) => d.key === 'edgetpu:pci:1')
    expect(second?.device).toBe('pci:1')
    expect(second?.format).toBe('tflite')
  })

  it('a node with both buses lists both, USB first', () => {
    const hw: HardwareInfo = {
      ...amdNode,
      coral: {
        type: 'coral-edgetpu',
        units: [
          { bus: 'usb', count: 1 },
          { bus: 'pci', count: 2 },
        ],
      },
    }
    expect(edgeKeys(hw)).toEqual(['edgetpu:usb', 'edgetpu:pci', 'edgetpu:pci:1'])
    expect(runtimeDevices('edgetpu', hw).map((o) => o.value)).toEqual(['usb', 'pci', 'pci:1'])
  })

  it('driver missing: no device key, no runtime offer, no score — but the Coral is reported', () => {
    const hw: HardwareInfo = {
      ...amdNode,
      coral: {
        type: 'coral-edgetpu',
        units: [],
        unavailable: [{ bus: 'pci', count: 2, reason: 'driver-missing' }],
      },
    }
    expect(edgeKeys(hw)).toEqual([])
    expect(supportedRuntimes(hw)).not.toContain('edgetpu')
    expect(scoreRuntimes(hw).scores.some((s) => s.backend === 'edgetpu')).toBe(false)
  })

  it('mixed: usable USB beside a driver-missing PCI unit enumerates only the USB', () => {
    const hw: HardwareInfo = {
      ...amdNode,
      coral: {
        type: 'coral-edgetpu',
        units: [{ bus: 'usb', count: 1 }],
        unavailable: [{ bus: 'pci', count: 1, reason: 'driver-missing' }],
      },
    }
    expect(edgeKeys(hw)).toEqual(['edgetpu:usb'])
    expect(supportedRuntimes(hw)).toContain('edgetpu')
  })
})

describe('edgetpuDelegateDevice — key device → libedgetpu device string', () => {
  it.each([
    ['usb', 'usb:0'],
    ['usb:1', 'usb:1'],
    ['usb:2', 'usb:2'],
    ['pci', 'pci:0'],
    ['pci:1', 'pci:1'],
  ])('%s → %s', (device, expected) => {
    expect(edgetpuDelegateDevice(device)).toBe(expected)
  })

  it('every enumerated key maps to an explicit, distinct ordinal device string', () => {
    const hw: HardwareInfo = {
      ...amdNode,
      coral: {
        type: 'coral-edgetpu',
        units: [
          { bus: 'usb', count: 2 },
          { bus: 'pci', count: 2 },
        ],
      },
    }
    const strings = enumerateInferenceDevices(hw)
      .filter((d) => d.backend === 'edgetpu')
      .map((d) => edgetpuDelegateDevice(d.device))
    expect(strings).toEqual(['usb:0', 'usb:1', 'pci:0', 'pci:1'])
  })

  it('refuses a device string libedgetpu does not address', () => {
    expect(() => edgetpuDelegateDevice('auto')).toThrow(/edgetpu device/)
    expect(() => edgetpuDelegateDevice('pci:x')).toThrow(/edgetpu device/)
  })
})
