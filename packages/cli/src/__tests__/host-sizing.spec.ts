import { describe, expect, it } from 'vitest'
import { hostCheck, type HostCheckReport } from '../host-check/host-check.js'
import type { HostFs } from '../host-check/probe.js'
import {
  assessFeasibility,
  renderFeasibility,
  type HostFacts,
  type SizingRequest,
} from '../host-check/sizing.js'
import { bundledManifest } from '../onboarding/manifest.js'

const sizing = bundledManifest().sizing

function fakeFs(files: Readonly<Record<string, string>>): HostFs {
  const paths = Object.keys(files)
  return {
    exists: (p) => p in files || paths.some((f) => f.startsWith(`${p}/`)),
    readText: (p) => files[p] ?? null,
    listDir: (p) => {
      const names = new Set<string>()
      for (const f of paths) {
        if (f.startsWith(`${p}/`)) names.add(f.slice(p.length + 1).split('/')[0] ?? '')
      }
      return [...names].toSorted()
    },
  }
}

function linuxHost(cpuModel: string, intelGpu: boolean): HostCheckReport {
  return hostCheck({
    platform: 'linux',
    nvidiaSmi: null,
    fs: fakeFs({
      '/proc/cpuinfo': `vendor_id\t: GenuineIntel\nmodel name\t: ${cpuModel}\n`,
      '/etc/group': 'render:x:992:\n',
      ...(intelGpu
        ? {
            '/sys/bus/pci/devices/0000:00:02.0/class': '0x030000\n',
            '/sys/bus/pci/devices/0000:00:02.0/vendor': '0x8086\n',
            '/sys/bus/pci/devices/0000:00:02.0/device': '0x46d1\n',
            '/sys/class/drm/renderD128/device/uevent': 'DRIVER=i915\nPCI_SLOT_NAME=0000:00:02.0\n',
            '/dev/dri/renderD128': '',
          }
        : {}),
    }),
  })
}

const N100 = 'Intel(R) N100'
const request: SizingRequest = {
  cameras: 8,
  mainStream: '4k',
  codec: 'h265',
  recording: 'continuous',
  retentionDays: 14,
}
const roomy: HostFacts = { cpuModel: null, ramGb: 16, cores: 4, diskFreeGb: 8000, diskPath: '/r' }

describe('assessFeasibility', () => {
  it('sizes memory, CPU and disk from the published figures, not from constants of its own', () => {
    const report = assessFeasibility(request, roomy, linuxHost(N100, true), sizing)
    const [ramLow, ramHigh] = sizing.hubBaselineRamGb
    expect(report.ram.needGb).toEqual([
      Math.round((ramLow + 8 * sizing.perCameraRamGb) * 10) / 10,
      Math.round((ramHigh + 8 * sizing.perCameraRamGb) * 10) / 10,
    ])
    const perDay =
      Math.round((sizing.bitrateMbit['4k-h265'] ?? 0) * sizing.gbPerDayPerMbit * 8 * 10) / 10
    expect(report.disk.gbPerDay).toEqual([perDay, perDay])
    expect(report.disk.forRetentionGb?.[0]).toBeCloseTo(perDay * 14, 0)
    expect(report.cpu.busyCores[1]).toBeGreaterThan(report.cpu.typicalCores[1])
  })

  it('answers hub-only on a measured class with an accelerator, and still calls it provisional', () => {
    const report = assessFeasibility(request, roomy, linuxHost(N100, true), sizing)
    expect(report.verdict).toBe('hub-only')
    expect(report.provisional).toBe(true)
    expect(report.hardware).toMatchObject({ hardwareClass: 'intel-n-series', measured: true })
  })

  it('answers hub-plus-agents with the limit stated when only a CPU would detect', () => {
    const report = assessFeasibility(request, roomy, linuxHost(N100, false), sizing)
    expect(report.verdict).toBe('hub-plus-agents')
    expect(report.reasons[0]).toMatch(/CPU alone was never measured/)
    expect(JSON.stringify(report)).not.toMatch(/camerasOnCpu|cpuOnlyCameras/)
  })

  it('answers hub-plus-agents on hardware outside the measured tables', () => {
    const cpu = 'Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz'
    const report = assessFeasibility(request, roomy, linuxHost(cpu, true), sizing)
    expect(report.hardware).toMatchObject({ hardwareClass: 'unknown', measured: false })
    expect(report.verdict).toBe('hub-plus-agents')
    expect(report.reasons[0]).toMatch(/not in the measured tables/)
  })

  it('refuses a machine at or under the too-tight memory figure', () => {
    const small = { ...roomy, ramGb: sizing.tightHubRamGb }
    const report = assessFeasibility(request, small, linuxHost(N100, true), sizing)
    expect(report.verdict).toBe('not-a-hub')
    expect(report.ram.fit).toBe('short')
    expect(report.reasons[0]).toMatch(/too tight/)
  })

  it('keeps an unreadable fact unknown instead of reading it as zero', () => {
    const blind: HostFacts = {
      cpuModel: null,
      ramGb: null,
      cores: null,
      diskFreeGb: null,
      diskPath: null,
    }
    const report = assessFeasibility(request, blind, linuxHost(N100, true), sizing)
    expect(report.ram).toMatchObject({ haveGb: null, fit: 'unknown' })
    expect(report.cpu.fit).toBe('unknown')
    expect(report.disk.fit).toBe('unknown')
    expect(report.verdict).toBe('hub-only')
    expect(report.limits.join(' ')).toMatch(/memory of this machine could not be read/)
  })

  it('does not size the disk for a stream nobody measured, unless a bitrate is given', () => {
    const hd: SizingRequest = { ...request, mainStream: '1080p' }
    const unsized = assessFeasibility(hd, roomy, linuxHost(N100, true), sizing)
    expect(unsized.disk.gbPerDay).toBeNull()
    expect(unsized.limits.join(' ')).toMatch(/no bitrate was measured for 1080p h265/)
    const given = assessFeasibility({ ...hd, bitrateMbit: 2 }, roomy, linuxHost(N100, true), sizing)
    expect(given.disk.gbPerDay?.[0]).toBeCloseTo(2 * sizing.gbPerDayPerMbit * 8, 1)
  })

  it('treats Apple silicon as its own accelerator, from the CPU string the OS reports', () => {
    const mac = hostCheck({ platform: 'darwin', fs: fakeFs({}), nvidiaSmi: null })
    const report = assessFeasibility(request, { ...roomy, cpuModel: 'Apple M2' }, mac, sizing)
    expect(report.hardware.hardwareClass).toBe('apple-m-base')
    expect(report.verdict).toBe('hub-only')
  })

  it('renders the verdict, its reasons and what is not covered', () => {
    const out = renderFeasibility(assessFeasibility(request, roomy, linuxHost(N100, false), sizing))
    expect(out).toMatch(/Verdict \(provisional\): use this machine as the hub and add an agent/)
    expect(out).toMatch(/Not covered:/)
  })
})
