import { describe, expect, it, vi } from 'vitest'
import { findOnPath, readNvidiaGpu } from '../gpu-probe.js'

/**
 * The Linux GPU probe forked `nvidia-smi` every sample (12 times a minute
 * from hub-main) on a host that has no NVIDIA GPU and no `nvidia-smi`: twelve
 * forks a minute of the largest process on the host, every one of which
 * failed at exec and produced `null` (D452). Whether the binary exists is a
 * question `access(2)` answers without a fork.
 */
describe('findOnPath', () => {
  it('returns the first PATH entry where the binary is executable', async () => {
    const access = vi.fn(async (p: string) => {
      if (p !== '/usr/bin/nvidia-smi') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    await expect(findOnPath('nvidia-smi', '/usr/local/bin:/usr/bin:/bin', access)).resolves.toBe(
      '/usr/bin/nvidia-smi',
    )
  })

  it('is null when no PATH entry has it', async () => {
    const access = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    await expect(findOnPath('nvidia-smi', '/usr/bin:/bin', access)).resolves.toBeNull()
    expect(access).toHaveBeenCalledTimes(2)
  })

  it('is null for an empty PATH without asking anything', async () => {
    const access = vi.fn(async () => undefined)
    await expect(findOnPath('nvidia-smi', undefined, access)).resolves.toBeNull()
    expect(access).not.toHaveBeenCalled()
  })
})

describe('readNvidiaGpu', () => {
  it('does not fork when nvidia-smi is not on PATH', async () => {
    const exec = vi.fn(async () => '')
    const result = await readNvidiaGpu({ findOnPath: async () => null, exec })
    expect(result).toBeNull()
    expect(exec).not.toHaveBeenCalled()
  })

  it('runs the resolved binary and parses the csv when it is present', async () => {
    const exec = vi.fn(async () => '37, NVIDIA GeForce RTX 3060, 1024, 12288, 51\n')
    const result = await readNvidiaGpu({ findOnPath: async () => '/usr/bin/nvidia-smi', exec })
    expect(exec).toHaveBeenCalledWith('/usr/bin/nvidia-smi', expect.any(Array))
    expect(result).toEqual({
      utilization: 37,
      model: 'NVIDIA GeForce RTX 3060',
      memoryUsedBytes: 1024 * 1024 * 1024,
      memoryTotalBytes: 12288 * 1024 * 1024,
      temperature: 51,
    })
  })

  it('is null, not a throw, when the binary is present but fails', async () => {
    const exec = vi.fn(async () => {
      throw new Error('NVML: Driver/library version mismatch')
    })
    await expect(
      readNvidiaGpu({ findOnPath: async () => '/usr/bin/nvidia-smi', exec }),
    ).resolves.toBeNull()
  })
})
