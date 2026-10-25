/**
 * Example spec exercising the codegen'd metrics-provider router end-to-end:
 *  - Wires a mock provider into `metricsProvider router`
 *  - Verifies happy-path query dispatch + output validation for getCurrent()
 *  - Verifies provider-missing → PRECONDITION_FAILED
 */
import { describe, it, expect } from 'vitest'
import { type IMetricsProvider } from '@camstack/types'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

/** The methods this spec's routes reach; the harness takes any provider object. */
function makeMockProvider(overrides: Partial<IMetricsProvider> = {}): Partial<IMetricsProvider> {
  return {
    collectSnapshot: async () => ({
      cpu: { total: 0, user: 0, system: 0, irq: 0, nice: 0, loadAvg: [0, 0, 0], cores: 1 },
      memory: {
        percent: 0,
        totalBytes: 0,
        usedBytes: 0,
        availableBytes: 0,
        swapUsedBytes: 0,
        swapTotalBytes: 0,
      },
      gpu: null,
      network: {
        rxBytes: 0,
        txBytes: 0,
        rxPackets: 0,
        txPackets: 0,
        rxErrors: 0,
        txErrors: 0,
        timestampMs: 0,
      },
      disk: { readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, timestampMs: 0 },
      pressure: { cpu: null, memory: null, io: null },
      process: { openFds: 0, threadCount: 0, activeHandles: 0, activeRequests: 0 },
      cpuTemperature: null,
      timestampMs: 0,
    }),
    getCached: async () => null,
    getCurrent: async () => ({
      cpuPercent: 42.5,
      memoryPercent: 68.2,
      memoryUsedMB: 8192,
      memoryTotalMB: 16384,
      diskPercent: 55.1,
      temperature: 48.0,
    }),
    getDiskSpace: async ({ dirPath }) => ({
      path: dirPath,
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      percent: 0,
    }),
    getGpuInfo: async () => null,
    getCpuTemperature: async () => null,
    getProcessStats: async () => [],
    ...overrides,
  }
}

describe('metricsProvider router', () => {
  describe('happy path', () => {
    it('dispatches getCurrent() to the provider and returns typed metrics', async () => {
      const provider = makeMockProvider()
      const router = buildCapRouterForTest('metrics-provider', () => provider)

      const outcome = await invokeProcedure(router, 'getCurrent', makeCtx('admin'))

      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.value).toMatchObject({
          cpuPercent: 42.5,
          memoryPercent: 68.2,
          memoryUsedMB: 8192,
          memoryTotalMB: 16384,
        })
      }
    })

    it('propagates optional fields (temperature, gpuPercent)', async () => {
      const router = buildCapRouterForTest('metrics-provider', () =>
        makeMockProvider({
          getCurrent: async () => ({
            cpuPercent: 10,
            memoryPercent: 20,
            memoryUsedMB: 1024,
            memoryTotalMB: 8192,
            gpuPercent: 75,
            gpuMemoryPercent: 60,
          }),
        }),
      )

      const outcome = await invokeProcedure(router, 'getCurrent', makeCtx('admin'))

      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        const value = outcome.value as { gpuPercent?: number; gpuMemoryPercent?: number }
        expect(value.gpuPercent).toBe(75)
        expect(value.gpuMemoryPercent).toBe(60)
      }
    })
  })

  describe('auth', () => {
    it('rejects anonymous (protected endpoint)', async () => {
      const router = buildCapRouterForTest('metrics-provider', () => makeMockProvider())
      const outcome = await invokeProcedure(router, 'getCurrent', makeCtx('anonymous'))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.code).toBe('UNAUTHORIZED')
    })

    it('allows viewer (protected endpoint)', async () => {
      const router = buildCapRouterForTest('metrics-provider', () => makeMockProvider())
      const outcome = await invokeProcedure(router, 'getCurrent', makeCtx('user'))
      expect(outcome.ok).toBe(true)
    })
  })

  describe('missing provider', () => {
    it('throws PRECONDITION_FAILED when getProvider returns null', async () => {
      const router = buildCapRouterForTest('metrics-provider', () => null)
      const outcome = await invokeProcedure(router, 'getCurrent', makeCtx('admin'))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.code).toBe('PRECONDITION_FAILED')
        expect(outcome.message).toContain('metrics-provider')
      }
    })
  })
})
