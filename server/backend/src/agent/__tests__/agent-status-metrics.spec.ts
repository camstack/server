import * as os from 'node:os'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentService, type StatusMetricsSource } from '../agent-service.js'
import { resolveStatusMetrics } from '../agent-status-metrics.js'

const READER_PERCENT = 62
const GIB = 1024 * 1024 * 1024

const workingReader: StatusMetricsSource = {
  getCached: async () => ({
    cpu: { total: 7, user: 0, system: 0, irq: 0, nice: 0, loadAvg: [0, 0, 0], cores: 1 },
    memory: {
      percent: READER_PERCENT,
      totalBytes: 8 * GIB,
      usedBytes: 4 * GIB,
      availableBytes: 4 * GIB,
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
}

describe('$agent.status memory on an unpaired agent', () => {
  let broker: ServiceBroker
  afterEach(async () => {
    await broker.stop()
  })

  it('reads memory from the host reader when the registry has no metrics provider', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-unpaired', transporter: 'Fake', logger: false })
    broker.createService(
      createAgentService({
        addonsDir: os.tmpdir(),
        agentName: 'unpaired',
        configPath: '/tmp/unpaired-agent.json',
        dataDir: os.tmpdir(),
        loadedAddons: new Map(),
        getMetricsProvider: resolveStatusMetrics(
          () => null,
          () => workingReader,
        ),
      }),
    )
    await broker.start()
    const status = (await broker.call('$agent.status')) as Record<string, unknown>
    expect(status['memoryPercent']).toBe(READER_PERCENT)
  })

  it('prefers the registry provider once the addon has booted', () => {
    const source = resolveStatusMetrics(
      () => workingReader,
      () => {
        throw new Error('fallback must not be asked')
      },
    )
    expect(source()).toBe(workingReader)
  })
})
