/**
 * `PlatformScorer.probeHardware` on a (faked) Windows host: the GPU and the AMD
 * NPU come from WMI through the Windows probe, the Linux /sys branch is not
 * entered, and a failing probe never fails boot.
 */
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

const fakes = vi.hoisted(() => ({
  exec: async (_file: string, _args: readonly string[]): Promise<{ stdout: string }> => ({
    stdout: '',
  }),
  calls: [] as string[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(() => undefined, {
    [promisify.custom]: async (file: string, args: readonly string[]) => {
      fakes.calls.push(file)
      return fakes.exec(file, args)
    },
  })
  return { ...actual, execFile }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const patched = { ...actual, platform: () => 'win32' as const, arch: () => 'x64' as const }
  return { ...patched, default: patched }
})

import type { CoralFs } from '../coral-accelerators.js'
import { PlatformScorer } from '../platform-scorer.js'

/** A host with no Coral: the scan must not read the real `/sys` of the machine running the spec. */
const NO_CORAL: CoralFs = {
  listUsbDevices: () => [],
  readUsbAttr: () => '',
  listPciDevices: () => [],
  readPciAttr: () => '',
  listApexClass: () => [],
  canOpen: () => false,
  exists: () => false,
}

function logger(): IScopedLogger {
  const noop = (): void => {}
  const l = { info: noop, warn: noop, error: noop, debug: noop, trace: noop } as const
  return { ...l, child: () => logger(), withTags: () => logger() } as unknown as IScopedLogger
}

const POWERSHELL_JSON = JSON.stringify({
  gpu: [{ Name: 'AMD Radeon(TM) 780M Graphics', PNPDeviceID: 'PCI\\VEN_1002&DEV_15BF\\4&2A' }],
  npu: [{ Name: 'AMD IPU Device', PNPDeviceID: 'PCI\\VEN_1022&DEV_1502&REV_00\\4&9' }],
})

beforeEach(() => {
  fakes.calls.length = 0
  fakes.exec = async (file) => {
    if (/powershell/i.test(file)) return { stdout: POWERSHELL_JSON }
    throw new Error(`${file}: not found`)
  }
})

describe('probeHardware on win32', () => {
  it('reports the AMD iGPU and the XDNA NPU that WMI names', async () => {
    const hw = await new PlatformScorer(logger(), null, NO_CORAL).probeHardware()
    expect(hw.platform).toBe('win32')
    expect(hw.gpu).toEqual({ type: 'amd', name: 'AMD Radeon(TM) 780M Graphics' })
    expect(hw.npu).toEqual({
      type: 'amd-xdna',
      name: 'AMD XDNA1 NPU',
      generation: 'xdna1',
    })
    expect(hw.coral).toBeNull()
  })

  it('lets nvidia-smi give the exact NVIDIA model and VRAM over WMI', async () => {
    fakes.exec = async (file) => {
      if (/nvidia-smi/.test(file)) return { stdout: 'NVIDIA GeForce RTX 3060, 12288 MiB\n' }
      return { stdout: POWERSHELL_JSON }
    }
    const hw = await new PlatformScorer(logger(), null, NO_CORAL).probeHardware()
    expect(hw.gpu).toEqual({ type: 'nvidia', name: 'NVIDIA GeForce RTX 3060', memoryMB: 12288 })
    expect(hw.npu?.type).toBe('amd-xdna')
  })

  it('still boots, as a CPU node, when no probe can run', async () => {
    fakes.exec = async () => {
      throw new Error('spawn ENOENT')
    }
    const hw = await new PlatformScorer(logger(), null, NO_CORAL).probeHardware()
    expect(hw.gpu).toBeNull()
    expect(hw.npu).toBeNull()
  })
})
