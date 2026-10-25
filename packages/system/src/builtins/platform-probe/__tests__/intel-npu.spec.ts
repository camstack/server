import { describe, it, expect } from 'vitest'
import { classifyIntelNpu, type IntelNpuContext, type NpuFs } from '../intel-npu.js'

const linuxIntel: IntelNpuContext = { platform: 'linux', arch: 'x64', intelPresent: true }

function makeFs(over: Partial<NpuFs> = {}): NpuFs {
  return {
    listDir: () => [],
    exists: () => false,
    ...over,
  }
}

describe('classifyIntelNpu', () => {
  it('detects the NPU when /dev/accel/accel0 is listed on linux+x64+intel', () => {
    const fs = makeFs({ listDir: (p) => (p === '/dev/accel' ? ['accel0'] : []) })
    expect(classifyIntelNpu(linuxIntel, fs)).toEqual({
      type: 'intel-npu',
      name: 'Intel AI Boost NPU',
    })
  })

  it('is tolerant of a non-zero accel ordinal (matches any accel* node)', () => {
    const fs = makeFs({ listDir: (p) => (p === '/dev/accel' ? ['accel1'] : []) })
    expect(classifyIntelNpu(linuxIntel, fs)).toEqual({
      type: 'intel-npu',
      name: 'Intel AI Boost NPU',
    })
  })

  it('falls back to an exists() probe of accel0 when the dir cannot be enumerated', () => {
    const fs = makeFs({ exists: (p) => p === '/dev/accel/accel0' })
    expect(classifyIntelNpu(linuxIntel, fs)).toEqual({
      type: 'intel-npu',
      name: 'Intel AI Boost NPU',
    })
  })

  it('returns null when no accel node is present', () => {
    expect(classifyIntelNpu(linuxIntel, makeFs())).toBeNull()
  })

  it('returns null on darwin even when an accel node exists', () => {
    const fs = makeFs({ listDir: () => ['accel0'] })
    expect(
      classifyIntelNpu({ platform: 'darwin', arch: 'arm64', intelPresent: false }, fs),
    ).toBeNull()
  })

  it('returns null on non-x64 arch', () => {
    const fs = makeFs({ listDir: () => ['accel0'] })
    expect(
      classifyIntelNpu({ platform: 'linux', arch: 'arm64', intelPresent: true }, fs),
    ).toBeNull()
  })

  it('returns null when no Intel CPU/iGPU is present (guards against foreign accel drivers)', () => {
    const fs = makeFs({ listDir: () => ['accel0'] })
    expect(classifyIntelNpu({ platform: 'linux', arch: 'x64', intelPresent: false }, fs)).toBeNull()
  })
})
