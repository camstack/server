/**
 * The executor's own node enumeration (`envToHardwareInfo` →
 * `enumerateInferenceDevices`, the path `resolveAutoEngine` and the probe
 * forward take) sees a Coral's UNITS, not just "a Coral exists".
 *
 * It used to narrow the probed Coral to `{ type }`, so every Coral read as one
 * USB unit: a PCIe-only node would have built an `edgetpu:usb` pool for a USB
 * Coral it does not have, and a driverless one would have been offered at all.
 */
import { enumerateInferenceDevices, supportedRuntimes, type CoralInfo } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { envToHardwareInfo, type RuntimeEnv } from '../runtimes.js'

function amdEnv(coral: CoralInfo): RuntimeEnv {
  return { platform: 'linux', arch: 'x64', hardware: { npu: null, gpu: { type: 'amd' }, coral } }
}

function edgeKeys(env: RuntimeEnv): readonly string[] {
  return enumerateInferenceDevices(envToHardwareInfo(env))
    .filter((d) => d.backend === 'edgetpu')
    .map((d) => d.key)
}

describe('Coral units reach the executor node enumeration', () => {
  it('two PCIe units → edgetpu:pci + edgetpu:pci:1, and no phantom USB key', () => {
    const env = amdEnv({ type: 'coral-edgetpu', units: [{ bus: 'pci', count: 2 }] })
    expect(edgeKeys(env)).toEqual(['edgetpu:pci', 'edgetpu:pci:1'])
  })

  it('a driverless PCIe Coral offers no edgetpu runtime and no device', () => {
    const env = amdEnv({
      type: 'coral-edgetpu',
      units: [],
      unavailable: [{ bus: 'pci', count: 2, reason: 'driver-missing' }],
    })
    expect(edgeKeys(env)).toEqual([])
    expect(supportedRuntimes(envToHardwareInfo(env))).not.toContain('edgetpu')
  })
})
