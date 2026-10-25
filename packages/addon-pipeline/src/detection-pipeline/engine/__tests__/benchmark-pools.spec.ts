import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BENCHMARK_POOL_IDLE_TTL_MS,
  BenchmarkPools,
  benchmarkKeyOf,
  benchmarkPlacementOf,
  isBenchmarkRun,
  isExclusiveDevice,
} from '../benchmark-pools.js'

describe('isBenchmarkRun — a benchmark is a one-shot image with no camera', () => {
  it('a one-shot image call is a benchmark', () => {
    expect(isBenchmarkRun({})).toBe(true)
  })
  it('a camera call is not', () => {
    expect(isBenchmarkRun({ deviceId: 101 })).toBe(false)
  })
  it('a live frame is not (the capacity ramp and the synthetic bench send frames)', () => {
    expect(
      isBenchmarkRun({
        frame: { data: new Uint8Array(0), width: 1, height: 1, format: 'rgb', timestamp: 1 },
      }),
    ).toBe(false)
  })
  it('a replay of stored media is not', () => {
    expect(isBenchmarkRun({ replay: true })).toBe(false)
  })
})

describe('benchmarkPlacementOf — an exclusive device is benchmarked through its live pool', () => {
  it('an Edge TPU, any unit, is exclusive', () => {
    expect(isExclusiveDevice('edgetpu:usb')).toBe(true)
    expect(isExclusiveDevice('edgetpu:pci:1')).toBe(true)
  })
  it('shared devices are not', () => {
    for (const key of [
      'openvino:gpu',
      'openvino:npu',
      'coreml:ane',
      'cuda:0',
      'onnx:webgpu',
      'cpu',
    ]) {
      expect(isExclusiveDevice(key)).toBe(false)
    }
  })
  it('a benchmark on a shared device keeps its own pool; on a Coral it uses the live one', () => {
    expect(benchmarkPlacementOf(true, 'openvino:gpu')).toBe('benchmark-pool')
    expect(benchmarkPlacementOf(true, 'edgetpu:usb')).toBe('live-pool')
    expect(benchmarkPlacementOf(false, 'openvino:gpu')).toBe('live-pool')
  })
})

describe('benchmarkKeyOf — a benchmark keeps its own load history', () => {
  it('differs from the live device key', () => {
    expect(benchmarkKeyOf('openvino:gpu')).not.toBe('openvino:gpu')
  })
})

interface FakePool {
  readonly id: number
  ready: boolean
  disposed: boolean
  isReady(): boolean
  dispose(): Promise<void>
}

function makePools(ttlMs?: number): { pools: BenchmarkPools<FakePool, string>; built: FakePool[] } {
  const built: FakePool[] = []
  const pools = new BenchmarkPools<FakePool, string>({
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    create: async () => {
      const pool: FakePool = {
        id: built.length,
        ready: true,
        disposed: false,
        isReady: () => pool.ready,
        dispose: async () => {
          pool.disposed = true
        },
      }
      built.push(pool)
      return pool
    },
  })
  return { pools, built }
}

describe('BenchmarkPools', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('builds one pool per device and hands it back warm', async () => {
    const { pools, built } = makePools()
    const a = await pools.acquire('openvino:gpu', 'e')
    const b = await pools.acquire('openvino:gpu', 'e')
    expect(a).toBe(b)
    expect(built).toHaveLength(1)
  })

  it('concurrent first calls share one spawn', async () => {
    const { pools, built } = makePools()
    await Promise.all([pools.acquire('openvino:gpu', 'e'), pools.acquire('openvino:gpu', 'e')])
    expect(built).toHaveLength(1)
  })

  it('replaces a pool that died, and disposes the corpse', async () => {
    const { pools, built } = makePools()
    const first = await pools.acquire('openvino:gpu', 'e')
    first.ready = false
    const second = await pools.acquire('openvino:gpu', 'e')
    expect(second).not.toBe(first)
    expect(first.disposed).toBe(true)
    expect(built).toHaveLength(2)
  })

  it('reclaims a pool idle past the TTL; the next call builds a fresh one', async () => {
    const { pools, built } = makePools()
    const first = await pools.acquire('openvino:gpu', 'e')
    await vi.advanceTimersByTimeAsync(BENCHMARK_POOL_IDLE_TTL_MS)
    expect(first.disposed).toBe(true)
    expect(pools.deviceKeys()).toEqual([])
    await pools.acquire('openvino:gpu', 'e')
    expect(built).toHaveLength(2)
  })

  it('disposeAll stops every pool', async () => {
    const { pools, built } = makePools()
    await pools.acquire('openvino:gpu', 'e')
    await pools.acquire('openvino:npu', 'e')
    await pools.disposeAll()
    expect(built.every((p) => p.disposed)).toBe(true)
    expect(pools.deviceKeys()).toEqual([])
  })
})
