import { describe, expect, it } from 'vitest'
import { hostCheck, renderHostCheck, type HostCheckReport } from '../host-check/host-check.js'
import type { HostFs } from '../host-check/probe.js'

/**
 * A fake /sys + /dev + /etc tree: every key is a file (a device node is a file
 * with empty content); directories are derived from the paths.
 */
function fakeFs(files: Readonly<Record<string, string>>): HostFs {
  const paths = Object.keys(files)
  return {
    exists: (p) => p in files || paths.some((f) => f.startsWith(`${p}/`)),
    readText: (p) => files[p] ?? null,
    listDir: (p) => {
      const prefix = `${p}/`
      const names = new Set<string>()
      for (const f of paths) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]!)
      }
      return [...names].toSorted()
    },
  }
}

function pciGpu(slot: string, vendor: string, device: string): Record<string, string> {
  return {
    [`/sys/bus/pci/devices/${slot}/class`]: '0x030000\n',
    [`/sys/bus/pci/devices/${slot}/vendor`]: `${vendor}\n`,
    [`/sys/bus/pci/devices/${slot}/device`]: `${device}\n`,
  }
}

function renderNode(name: string, slot: string): Record<string, string> {
  return {
    [`/sys/class/drm/${name}/device/uevent`]: `DRIVER=x\nPCI_SLOT_NAME=${slot}\n`,
    [`/dev/dri/${name}`]: '',
  }
}

const INTEL_CPU = {
  '/proc/cpuinfo':
    'vendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz\n',
  '/etc/group': 'video:x:44:\nrender:x:992:\n',
}

/** The reported host: i7-8700K (UHD 630) + RTX 2060, Debian 13, Docker. */
const I7_8700K_RTX2060 = {
  ...INTEL_CPU,
  ...pciGpu('0000:00:02.0', '0x8086', '0x3e92'),
  ...pciGpu('0000:01:00.0', '0x10de', '0x1f08'),
  ...renderNode('renderD128', '0000:00:02.0'),
  ...renderNode('renderD129', '0000:01:00.0'),
  '/dev/nvidia0': '',
  '/dev/nvidiactl': '',
}

function check(files: Record<string, string>, nvidiaSmi: string | null = null): HostCheckReport {
  return hostCheck({ platform: 'linux', fs: fakeFs(files), nvidiaSmi })
}

function kinds(report: HostCheckReport, status: string): readonly string[] {
  return report.accelerators.filter((a) => a.status === status).map((a) => a.kind)
}

describe('host-check — the reported i7-8700K + RTX 2060 host', () => {
  const report = check(I7_8700K_RTX2060, 'GPU 0: NVIDIA GeForce RTX 2060 (UUID: GPU-1)')

  it('uses the Intel iGPU and lists NVIDIA as not supported yet', () => {
    expect(kinds(report, 'used')).toEqual(['intel-gpu'])
    expect(kinds(report, 'unsupported')).toEqual(['nvidia'])
    const nvidia = report.accelerators.find((a) => a.kind === 'nvidia')
    expect(nvidia?.label).toContain('RTX 2060')
    expect(nvidia?.note).toMatch(/not supported yet/i)
  })

  it('picks the intel image and passes /dev/dri only — never a GPU runtime flag', () => {
    expect(report.imageTag).toBe('intel-latest')
    expect(report.passthrough.devices).toEqual(['/dev/dri'])
    expect(report.passthrough.dockerRunFlags).toEqual(['--device /dev/dri'])
    expect(report.passthrough.compose).toContain('- /dev/dri:/dev/dri')
    const all = JSON.stringify(report.passthrough)
    expect(all).not.toMatch(/--gpus|nvidia|\/dev\/kfd/)
  })

  it('names the Unraid field and the Proxmox device line with the render gid', () => {
    expect(report.passthrough.unraid.deviceFields).toEqual(['Intel/AMD iGPU: /dev/dri'])
    expect(report.passthrough.unraid.extraParameters).toContain('--device=/dev/dri')
    expect(report.passthrough.proxmoxLxc).toContain('dev0: /dev/dri/renderD128,gid=992,mode=0660')
    expect(report.passthrough.proxmoxLxc.join('\n')).not.toContain('renderD129')
  })

  it('renders a human report naming the hardware and the flags', () => {
    const out = renderHostCheck(report)
    expect(out).toContain('intel-latest')
    expect(out).toContain('--device /dev/dri')
    expect(out).toMatch(/NVIDIA.*not supported yet/i)
  })
})

describe('host-check — hardware matrix', () => {
  it('an Intel CPU whose iGPU is off (dGPU only) is told to enable it in the BIOS', () => {
    const report = check({
      ...INTEL_CPU,
      ...pciGpu('0000:01:00.0', '0x10de', '0x1f08'),
      ...renderNode('renderD128', '0000:01:00.0'),
      '/dev/nvidia0': '',
    })
    expect(kinds(report, 'used')).toEqual([])
    expect(report.passthrough.devices).toEqual([])
    expect(report.hints.join('\n')).toMatch(/BIOS/)
    expect(report.imageTag).toBe('intel-latest')
  })

  it('an AMD iGPU takes the amd image and /dev/dri, never /dev/kfd', () => {
    const report = check({
      '/proc/cpuinfo': 'vendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 7 7840HS\n',
      ...pciGpu('0000:c4:00.0', '0x1002', '0x15bf'),
      ...renderNode('renderD128', '0000:c4:00.0'),
      '/dev/kfd': '',
      '/sys/class/accel/accel0/device/vendor': '0x1022\n',
      '/dev/accel/accel0': '',
    })
    expect(report.imageTag).toBe('amd-latest')
    expect(kinds(report, 'used')).toEqual(['amd-gpu'])
    expect(kinds(report, 'detected-not-used')).toEqual(['amd-npu'])
    expect(report.passthrough.devices).toEqual(['/dev/dri'])
  })

  it('an Intel NPU adds /dev/accel', () => {
    const report = check({
      ...INTEL_CPU,
      ...pciGpu('0000:00:02.0', '0x8086', '0x7d55'),
      ...renderNode('renderD128', '0000:00:02.0'),
      '/sys/class/accel/accel0/device/vendor': '0x8086\n',
      '/dev/accel/accel0': '',
    })
    expect(kinds(report, 'used')).toEqual(['intel-gpu', 'intel-npu'])
    expect(report.passthrough.devices).toEqual(['/dev/dri', '/dev/accel'])
    expect(report.passthrough.proxmoxLxc).toContain('dev1: /dev/accel/accel0,gid=992,mode=0660')
  })

  it('a Coral USB passes the bus and the cgroup rule; a PCIe Coral its apex node', () => {
    const report = check({
      '/sys/bus/usb/devices/2-1/idVendor': '18d1\n',
      '/sys/bus/usb/devices/2-1/idProduct': '9302\n',
      '/sys/class/apex/apex_0/dev': '120:0\n',
      '/dev/apex_0': '',
    })
    expect(kinds(report, 'used')).toEqual(['coral-usb', 'coral-pcie'])
    expect(report.passthrough.devices).toEqual(['/dev/bus/usb', '/dev/apex_0'])
    expect(report.passthrough.deviceCgroupRules).toEqual(['c 189:* rmw'])
    expect(report.passthrough.dockerRunFlags).toContain("--device-cgroup-rule='c 189:* rmw'")
    expect(report.passthrough.proxmoxLxc).toContain(
      'lxc.mount.entry: /dev/bus/usb dev/bus/usb none bind,optional,create=dir',
    )
  })

  it('a PCIe Coral without the apex driver is reported, not passed', () => {
    const report = check({
      '/sys/bus/pci/devices/0000:03:00.0/class': '0x088000\n',
      '/sys/bus/pci/devices/0000:03:00.0/vendor': '0x1ac1\n',
      '/sys/bus/pci/devices/0000:03:00.0/device': '0x089a\n',
    })
    expect(report.passthrough.devices).toEqual([])
    expect(kinds(report, 'detected-not-used')).toEqual(['coral-pcie'])
    expect(report.hints.join('\n')).toMatch(/apex driver/)
  })

  it('a Hailo is detected and not supported', () => {
    const report = check({ '/dev/hailo0': '' })
    expect(kinds(report, 'unsupported')).toEqual(['hailo'])
    expect(report.passthrough.devices).toEqual([])
  })

  it('nothing at all: CPU only, intel image, no devices', () => {
    const report = check({})
    expect(report.accelerators).toEqual([])
    expect(report.imageTag).toBe('intel-latest')
    expect(report.passthrough.dockerRunFlags).toEqual([])
    expect(report.hints.join('\n')).toMatch(/CPU/)
  })
})

describe('host-check — where it runs', () => {
  it('inside a container that did not get /dev/dri, says the device was not passed', () => {
    const files: Record<string, string> = {
      ...INTEL_CPU,
      ...pciGpu('0000:00:02.0', '0x8086', '0x3e92'),
      '/sys/class/drm/renderD128/device/uevent': 'PCI_SLOT_NAME=0000:00:02.0\n',
      '/.dockerenv': '',
    }
    const report = check(files)
    expect(report.environment.container).toBe('docker')
    const gpu = report.accelerators.find((a) => a.kind === 'intel-gpu')
    expect(gpu?.visibleHere).toBe(false)
    expect(report.hints.join('\n')).toMatch(/not passed into this docker container/i)
  })

  it('inside an LXC, points at the Proxmox host config', () => {
    const report = check({
      ...INTEL_CPU,
      ...pciGpu('0000:00:02.0', '0x8086', '0x3e92'),
      '/sys/class/drm/renderD128/device/uevent': 'PCI_SLOT_NAME=0000:00:02.0\n',
      '/run/systemd/container': 'lxc\n',
    })
    expect(report.environment.container).toBe('lxc')
    expect(report.hints.join('\n')).toMatch(/\/etc\/pve\/lxc\/<id>\.conf/)
  })

  it('macOS and Windows: use the native app, no scan', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const report = hostCheck({ platform, fs: fakeFs({}), nvidiaSmi: null })
      expect(report.nativeApp).toMatch(/desktop app/i)
      expect(report.imageTag).toBeNull()
      expect(report.accelerators).toEqual([])
    }
  })
})
