/**
 * `PlatformScorer.probeHardware` on a (faked) Linux host with an Intel iGPU AND
 * an NVIDIA card (the i7-8700K + RTX 2060 report): the NVIDIA card gets its own
 * slot — present, not usable without the CUDA execution provider — and never
 * takes `gpu`, so OpenVINO keeps the iGPU.
 */
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { enumerateInferenceDevices } from '@camstack/types'

const fakes = vi.hoisted(() => ({
  exec: async (_file: string, _args: readonly string[]): Promise<{ stdout: string }> => ({
    stdout: '',
  }),
  renderNodes: ['renderD128'] as string[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(() => undefined, {
    [promisify.custom]: async (file: string, args: readonly string[]) => fakes.exec(file, args),
  })
  return { ...actual, execFile }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const patched = { ...actual, platform: () => 'linux' as const, arch: () => 'x64' as const }
  return { ...patched, default: patched }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const missing = (p: string): Error => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
  const patched = {
    ...actual,
    readdirSync: (p: string) => {
      if (p === '/dev/dri') return [...fakes.renderNodes]
      throw missing(p)
    },
    readFileSync: (p: string) => {
      // UHD 630 behind renderD128.
      if (p === '/sys/class/drm/renderD128/device/vendor') return '0x8086\n'
      if (p === '/sys/class/drm/renderD128/device/device') return '0x3e92\n'
      throw missing(p)
    },
    existsSync: () => false,
  }
  return { ...patched, default: patched }
})

import type { CoralFs } from '../coral-accelerators.js'
import { PlatformScorer } from '../platform-scorer.js'

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

beforeEach(() => {
  fakes.renderNodes = ['renderD128']
  fakes.exec = async (file) => {
    if (/nvidia-smi/.test(file)) return { stdout: 'NVIDIA GeForce RTX 2060, 6144 MiB\n' }
    throw new Error(`${file}: not found`)
  }
})

describe('probeHardware on linux with an Intel iGPU and an NVIDIA card', () => {
  it('keeps the iGPU in gpu and reports NVIDIA present, not usable', async () => {
    const hw = await new PlatformScorer(logger(), null, NO_CORAL).probeHardware()
    expect(hw.gpu?.type).toBe('intel')
    expect(hw.nvidia).toEqual({
      type: 'nvidia',
      name: 'NVIDIA GeForce RTX 2060',
      memoryMB: 6144,
      usable: false,
      reason: 'no-cuda-execution-provider',
    })
    const keys = enumerateInferenceDevices(hw).map((d) => d.key)
    expect(keys).toContain('openvino:gpu')
    expect(keys.some((k) => k.startsWith('cuda'))).toBe(false)
  })

  it('an NVIDIA card alone leaves gpu null and is still reported', async () => {
    fakes.renderNodes = []
    const hw = await new PlatformScorer(logger(), null, NO_CORAL).probeHardware()
    expect(hw.gpu).toBeNull()
    expect(hw.nvidia?.usable).toBe(false)
  })
})
