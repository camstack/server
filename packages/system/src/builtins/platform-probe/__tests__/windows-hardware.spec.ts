/**
 * The Windows hardware probe: WMI text in, the same `hw.gpu` / `hw.npu` model
 * the Linux probe builds from /sys out. Parsing and classification are pure, so
 * they are tested here on any OS; the shape of the REAL output on a real
 * Windows host is the one thing a Mac cannot prove (see the module header).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  classifyWindowsAmdNpu,
  classifyWindowsGpu,
  parsePowershellOutput,
  parseWmicCsv,
  pciVendorOf,
  powershellInvocation,
  probeWindowsHardware,
  type WindowsProbeRunner,
} from '../windows-hardware.js'

const RADEON_780M = {
  Name: 'AMD Radeon(TM) 780M Graphics',
  PNPDeviceID: 'PCI\\VEN_1002&DEV_15BF&SUBSYS_0000&REV_C1\\4&2A',
}
const RTX_3060 = {
  Name: 'NVIDIA GeForce RTX 3060',
  PNPDeviceID: 'PCI\\VEN_10DE&DEV_2504&SUBSYS_0000\\4&1',
}
const INTEL_UHD = {
  Name: 'Intel(R) UHD Graphics 770',
  PNPDeviceID: 'PCI\\VEN_8086&DEV_4680&SUBSYS_0000\\3&1',
}
const NPU_PHOENIX = {
  Name: 'AMD IPU Device',
  PNPDeviceID: 'PCI\\VEN_1022&DEV_1502&SUBSYS_0000&REV_00\\4&9',
}

describe('parsePowershellOutput', () => {
  it('reads the arrays the script emits', () => {
    const out = parsePowershellOutput(JSON.stringify({ gpu: [RADEON_780M], npu: [NPU_PHOENIX] }))
    expect(out.controllers).toEqual([
      { name: RADEON_780M.Name, pnpDeviceId: RADEON_780M.PNPDeviceID },
    ])
    expect(out.pnp[0]?.pnpDeviceId).toContain('DEV_1502')
  })

  it('accepts a lone object, an empty value and a BOM — what PowerShell really does', () => {
    const out = parsePowershellOutput(`\uFEFF${JSON.stringify({ gpu: RTX_3060, npu: null })}`)
    expect(out.controllers).toHaveLength(1)
    expect(out.pnp).toEqual([])
  })
})

describe('parseWmicCsv', () => {
  it('keeps a device name that contains commas and takes the PNP id from the end', () => {
    const csv =
      '\r\nNode,Name,PNPDeviceID\r\nDESKTOP,"Radeon, 780M",PCI\\VEN_1002&DEV_15BF\\4&2A\r\n'
    expect(parseWmicCsv(csv)).toEqual([
      { name: '"Radeon, 780M"', pnpDeviceId: 'PCI\\VEN_1002&DEV_15BF\\4&2A' },
    ])
  })

  it('is empty for output with no table', () => {
    expect(parseWmicCsv('No Instance(s) Available.')).toEqual([])
  })
})

describe('classifyWindowsGpu', () => {
  const ctl = (c: { Name: string; PNPDeviceID: string }) => ({
    name: c.Name,
    pnpDeviceId: c.PNPDeviceID,
  })

  it('names the vendor from the PCI id, not from a marketing string', () => {
    expect(classifyWindowsGpu([ctl(RADEON_780M)])).toEqual({
      type: 'amd',
      name: RADEON_780M.Name,
    })
    expect(classifyWindowsGpu([ctl(RTX_3060)])?.type).toBe('nvidia')
    expect(pciVendorOf(INTEL_UHD.PNPDeviceID)).toBe('8086')
  })

  it('prefers NVIDIA, then Intel, then AMD — the Linux probe order', () => {
    expect(classifyWindowsGpu([ctl(INTEL_UHD), ctl(RTX_3060)])?.type).toBe('nvidia')
    expect(classifyWindowsGpu([ctl(RADEON_780M), ctl(INTEL_UHD)])?.type).toBe('intel')
  })

  it('never counts a virtual or remote adapter as the node GPU', () => {
    expect(
      classifyWindowsGpu([
        { name: 'Microsoft Basic Display Adapter', pnpDeviceId: 'ROOT\\BasicDisplay\\0000' },
        { name: 'Microsoft Hyper-V Video', pnpDeviceId: 'VMBUS\\{1}' },
        { name: 'Parsec Virtual Display Adapter', pnpDeviceId: 'ROOT\\DISPLAY\\0000' },
      ]),
    ).toBeNull()
  })
})

describe('classifyWindowsAmdNpu', () => {
  it('finds Phoenix / Hawk Point (DEV_1502) as XDNA1', () => {
    expect(
      classifyWindowsAmdNpu([{ name: NPU_PHOENIX.Name, pnpDeviceId: NPU_PHOENIX.PNPDeviceID }]),
    ).toEqual({ type: 'amd-xdna', name: 'AMD XDNA1 NPU', generation: 'xdna1' })
  })

  it('finds Strix (DEV_17F0) as XDNA2', () => {
    expect(
      classifyWindowsAmdNpu([{ name: 'NPU', pnpDeviceId: 'PCI\\VEN_1022&DEV_17F0&REV_00\\4&1' }])
        ?.generation,
    ).toBe('xdna2')
  })

  it('ignores other AMD devices and other vendors reusing the device id', () => {
    expect(
      classifyWindowsAmdNpu([
        { name: 'AMD SMBus', pnpDeviceId: 'PCI\\VEN_1022&DEV_790B\\3&1' },
        { name: 'not AMD', pnpDeviceId: 'PCI\\VEN_8086&DEV_1502\\3&1' },
      ]),
    ).toBeNull()
  })
})

describe('probeWindowsHardware', () => {
  const psJson = JSON.stringify({ gpu: [RADEON_780M], npu: [NPU_PHOENIX] })

  it('uses PowerShell, addressed by its System32 path, and fills gpu and npu together', async () => {
    const run = vi.fn<WindowsProbeRunner>(async () => psJson)
    const hw = await probeWindowsHardware(run, { systemRoot: 'D:\\Win' })
    expect(hw.source).toBe('powershell')
    expect(hw.gpu?.type).toBe('amd')
    expect(hw.npu?.generation).toBe('xdna1')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toBe(powershellInvocation('D:\\Win')[0])
    expect(run.mock.calls[0]?.[0]).toMatch(/^D:\\Win\\System32\\WindowsPowerShell/)
  })

  it('falls back to wmic when PowerShell cannot run, and says so', async () => {
    const reasons: string[] = []
    const run: WindowsProbeRunner = async (file) => {
      if (/powershell/i.test(file)) throw new Error('execution blocked by policy')
      return file === 'wmic'
        ? 'Node,Name,PNPDeviceID\r\nPC,NVIDIA GeForce RTX 3060,PCI\\VEN_10DE&DEV_2504\\4&1\r\n'
        : ''
    }
    const hw = await probeWindowsHardware(run, { onFallback: (r) => reasons.push(r) })
    expect(hw.source).toBe('wmic')
    expect(hw.gpu?.type).toBe('nvidia')
    expect(reasons[0]).toMatch(/PowerShell probe failed.*policy/)
  })

  it('never throws: with nothing able to run, the node is simply unaccelerated', async () => {
    const run: WindowsProbeRunner = async () => {
      throw new Error('spawn ENOENT')
    }
    await expect(probeWindowsHardware(run)).resolves.toEqual({
      gpu: null,
      npu: null,
      source: 'none',
    })
  })
})
