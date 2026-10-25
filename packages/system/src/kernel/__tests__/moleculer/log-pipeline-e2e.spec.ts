/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- test file pokes broker internals */
/**
 * End-to-end tests for every log delivery path into the unified
 * `LogManager` on the hub. The goal is to prove that regardless of
 * which transport a log entry comes from — in-process hub addon,
 * forked worker via `$hub.log`, or remote agent via
 * `log-receiver.ingest` — the final entry has consistent `tags`
 * (agentId / nodeId / addonId / deviceName / etc.) and `meta`, and
 * `formatLogLine` renders it in the canonical slot layout.
 *
 * Paths covered:
 *   1. In-process (hub addon → LogManager.createLogger → destinations)
 *   2. Forked worker (createRemoteLogger → broker.call('$hub.log') →
 *      HubServiceDeps.onLog → LogManager)
 *   3. Remote agent (agent LogManager → HubForwarderDestination.forward →
 *      log-receiver.ingest → LogManager)
 *   4. withTags propagation through every layer
 *   5. meta propagation through every layer
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { LogManager, type ILogDestination } from '../../../logging/log-manager.js'
import { HubForwarderDestination } from '../../../builtins/hub-forwarder/index.js'
import { formatLogLine } from '../../../logging/formatter.js'
import type { LogEntry } from '../../../logging/log-ring-buffer.js'
import { createHubService } from '../../moleculer/hub-service.js'
import { createAddonContext, setHubConnected } from '../../moleculer/addon-context-factory.js'

// ─── Capture destination ─────────────────────────────────────────────────────
class CapturingDestination implements ILogDestination {
  public readonly entries: LogEntry[] = []
  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {}
  write(entry: LogEntry): void {
    this.entries.push(entry)
  }
}

// ─── Hub harness ────────────────────────────────────────────────────────────
// Mirrors what `LoggingService.writeFromWorker` does in production: a
// tiny re-applier that reattaches tags + meta onto a fresh logger off
// LogManager before the write actually reaches destinations.
function installHubLogBridge(broker: ServiceBroker, logManager: LogManager): void {
  broker.createService(
    createHubService({
      getAddonConfig: () => ({}),
      getSettings: () => ({}),
      getRecentEvents: () => [],
      onLog: (entry) => {
        let logger = logManager.createLogger(entry.scope)
        const agentId = entry.nodeId.includes('/') ? entry.nodeId.split('/')[0]! : entry.nodeId
        logger = logger.withTags({
          ...entry.tags,
          addonId: entry.addonId,
          nodeId: entry.nodeId,
          agentId,
        })
        const extras = entry.meta !== undefined ? { meta: entry.meta } : undefined
        switch (entry.level) {
          case 'debug':
            logger.debug(entry.message, extras)
            break
          case 'warn':
            logger.warn(entry.message, extras)
            break
          case 'error':
            logger.error(entry.message, extras)
            break
          default:
            logger.info(entry.message, extras)
            break
        }
      },
    }),
  )
}

function installLogReceiverBridge(broker: ServiceBroker, logManager: LogManager): void {
  broker.createService({
    name: 'log-receiver',
    actions: {
      ingest: {
        handler(ctx: {
          params: {
            level: string
            message: string
            addonId: string
            nodeId: string
            scope?: string
            tags?: Record<string, unknown>
            meta?: Record<string, unknown>
          }
        }) {
          const p = ctx.params
          const logger0 = logManager.createLogger(p.scope)
          const agentId = p.nodeId.includes('/') ? p.nodeId.split('/')[0]! : p.nodeId
          const logger = logger0.withTags({
            ...p.tags,
            addonId: p.addonId,
            nodeId: p.nodeId,
            agentId,
          })
          const extras = p.meta !== undefined ? { meta: p.meta } : undefined
          switch (p.level) {
            case 'debug':
              logger.debug(p.message, extras)
              break
            case 'warn':
              logger.warn(p.message, extras)
              break
            case 'error':
              logger.error(p.message, extras)
              break
            default:
              logger.info(p.message, extras)
              break
          }
          return true
        },
      },
    },
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function flushBroker(): Promise<void> {
  // Moleculer Fake transport dispatches events synchronously but with a
  // microtask hop; one macrotask is enough for call + handler.
  await new Promise((r) => setTimeout(r, 50))
}

// Strip ANSI colour codes so assertions are independent of the runner's
// TTY / FORCE_COLOR state. The formatter emits colours when running
// attached to a TTY (nx with piped reporter, dev shells) and plain text
// otherwise (CI, direct vitest invocation). Tests should not care.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g
function plain(line: string): string {
  return line.replace(ANSI_RE, '')
}

describe('log pipeline e2e — every transport lands a normalized entry', () => {
  let hub: ServiceBroker
  let logManager: LogManager
  let destination: CapturingDestination

  beforeEach(async () => {
    logManager = new LogManager(100)
    destination = new CapturingDestination()
    logManager.addDestination(destination)
    hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    installHubLogBridge(hub, logManager)
    installLogReceiverBridge(hub, logManager)
    await hub.start()
  })

  afterEach(async () => {
    try {
      await hub.stop()
    } catch {
      /* already stopped */
    }
  })

  // ─── Path 1: in-process (hub-local addon) ──────────────────────────────────
  it('path#1 in-process: hub-local addon logs pass straight through with tags+meta', () => {
    const logger = logManager.createLogger('addon:stream-broker').withTags({
      addonId: 'stream-broker',
      nodeId: 'hub',
      agentId: 'hub',
      deviceName: 'hall',
      deviceId: 1,
    })

    logger.info('Registered streams', { meta: { count: 3, variant: 'high+mid+low' } })

    expect(destination.entries).toHaveLength(1)
    const entry = destination.entries[0]!
    expect(entry.message).toBe('Registered streams')
    expect(entry.tags?.addonId).toBe('stream-broker')
    expect(entry.tags?.agentId).toBe('hub')
    expect(entry.tags?.deviceName).toBe('hall')
    expect(entry.tags?.deviceId).toBe(1)
    expect(entry.meta).toEqual({ count: 3, variant: 'high+mid+low' })

    // Renderer produces the canonical NestJS layout.
    const line = plain(formatLogLine(entry))
    expect(line).toMatch(/^\[hub\/stream-broker\] /)
    expect(line).toContain('[hall]')
    expect(line).toContain('Registered streams')
    expect(line).toContain('count=3')
    // Scope collapses when the only entry matches the addon slot —
    // no duplicate `(stream-broker)` rendering.
    expect(line).not.toContain('(stream-broker)')
  })

  // ─── Path 2: forked worker via $hub.log ────────────────────────────────────
  it('path#2 forked-worker: createRemoteLogger → $hub.log → hub LogManager preserves tags+meta', async () => {
    const worker = new ServiceBroker({
      nodeID: 'hub/provider-rtsp',
      transporter: 'Fake',
      logger: false,
    })
    await worker.start()
    // Wait for hub discovery so `$hub.log` is reachable.
    await worker.waitForServices('$hub')
    setHubConnected()

    // Build an addon context on the worker — returns a remote logger
    // that targets `$hub.log`.
    const ctx = await createAddonContext(
      worker,
      {
        id: 'provider-rtsp',
        capabilities: [],
      },
      '/tmp/log-e2e',
    )

    // The worker context's ctx.logger is the remote logger; wrap it
    // with per-device tags like a real device-scoped call would.
    ctx.logger.info('probe failed', {
      tags: { deviceId: 7, deviceName: 'terrazzo' },
      meta: { url: 'rtsp://x', err: 'timeout' },
    })

    await flushBroker()
    await worker.stop()

    expect(destination.entries.length).toBeGreaterThanOrEqual(1)
    const entry = destination.entries.find((e) => e.message === 'probe failed')
    expect(entry, 'log entry for "probe failed" not delivered').toBeDefined()
    expect(entry!.tags?.addonId).toBe('provider-rtsp')
    // Forked-worker nodeId is preserved verbatim in tags — the formatter
    // derives the agent slot from `nodeId.split('/')[0]`.
    expect(entry!.tags?.nodeId).toBe('hub/provider-rtsp')
    expect(entry!.tags?.agentId).toBe('hub')
    expect(entry!.tags?.deviceId).toBe(7)
    expect(entry!.tags?.deviceName).toBe('terrazzo')
    expect(entry!.meta).toEqual({ url: 'rtsp://x', err: 'timeout' })

    // NestJS-style line: `[agent/addon]` brand bracket, `[device]`
    // context bracket. Forked-worker nodeId `hub/provider-rtsp` maps
    // to agentId=hub so the brand reads `[hub/provider-rtsp]`.
    const line = plain(formatLogLine(entry!))
    expect(line).toMatch(/^\[hub\/provider-rtsp\] /)
    expect(line).toContain('[terrazzo]')
    expect(line).toContain('probe failed')
  })

  // ─── Path 3: remote agent via log-receiver.ingest ──────────────────────────
  it('path#3 remote-agent: agent LogManager → HubForwarderDestination → log-receiver.ingest preserves tags+meta', async () => {
    const agent = new ServiceBroker({
      nodeID: 'dev-agent-0',
      transporter: 'Fake',
      logger: false,
    })
    await agent.start()
    await agent.waitForServices('log-receiver')

    // Agent has its own LogManager with a HubForwarderDestination.
    const agentLogManager = new LogManager(50)
    const forwarder = new HubForwarderDestination()
    await forwarder.initialize()
    agentLogManager.addDestination(forwarder)

    // Connect the forwarder to the broker so it starts dispatching.
    const brokerAdapter: any = {
      nodeID: agent.nodeID,
      call: (action: string, input: unknown) => agent.call(action, input),
      waitForServices: (names: string | string[]) => agent.waitForServices(names as any),
      localBus: { on: (..._a: unknown[]) => {} },
    }
    forwarder.connectBroker(brokerAdapter)
    await agent.waitForServices('log-receiver')
    await flushBroker()

    const agentLogger = agentLogManager.createLogger('addon:detection').withTags({
      addonId: 'detection',
      nodeId: 'dev-agent-0',
      agentId: 'dev-agent-0',
      deviceName: 'cortile',
      deviceId: 12,
    })
    agentLogger.warn('no detector for codec', { meta: { codec: 'av1' } })

    await flushBroker()
    await agent.stop()

    const entry = destination.entries.find((e) => e.message === 'no detector for codec')
    expect(entry, 'log entry not delivered through log-receiver.ingest').toBeDefined()
    expect(entry!.level).toBe('warn')
    expect(entry!.tags?.addonId).toBe('detection')
    expect(entry!.tags?.agentId).toBe('dev-agent-0')
    expect(entry!.tags?.nodeId).toBe('dev-agent-0')
    expect(entry!.tags?.deviceName).toBe('cortile')
    expect(entry!.tags?.deviceId).toBe(12)
    expect(entry!.meta).toEqual({ codec: 'av1' })

    const line = plain(formatLogLine(entry!))
    // NestJS-style: agent/addon joined in brand bracket, device in
    // its own context bracket after the level.
    expect(line).toMatch(/^\[dev-agent-0\/detection\] /)
    expect(line).toContain('[cortile]')
    expect(line).toContain('WARN')
    expect(line).toContain('codec=av1')
  })

  // ─── Path 4: withTags propagation (forked-worker regression) ───────────────
  it('path#4 forked-worker: withTags merges baseline + per-device tags across every emission', async () => {
    const worker = new ServiceBroker({
      nodeID: 'hub/onvif',
      transporter: 'Fake',
      logger: false,
    })
    await worker.start()
    await worker.waitForServices('$hub')
    setHubConnected()

    const ctx = await createAddonContext(
      worker,
      {
        id: 'onvif',
        capabilities: [],
      },
      '/tmp/log-e2e',
    )

    const deviceA = ctx.logger.withTags({ deviceId: 1, deviceName: 'a' })
    const deviceB = ctx.logger.withTags({ deviceId: 2, deviceName: 'b' })
    deviceA.info('message-for-a')
    deviceB.warn('message-for-b')
    await flushBroker()
    await worker.stop()

    const a = destination.entries.find((e) => e.message === 'message-for-a')
    const b = destination.entries.find((e) => e.message === 'message-for-b')
    expect(a?.tags?.deviceName).toBe('a')
    expect(a?.tags?.deviceId).toBe(1)
    expect(a?.tags?.addonId).toBe('onvif') // baseline preserved
    expect(b?.tags?.deviceName).toBe('b')
    expect(b?.tags?.deviceId).toBe(2)
    expect(b?.tags?.addonId).toBe('onvif')
    // The two loggers are independent — tags from one do not leak into the other.
    expect(a?.tags?.deviceId).not.toBe(b?.tags?.deviceId)
  })

  // ─── Path 5: meta round-trip (no JSON-stringify squash) ────────────────────
  it('path#5 forked-worker: meta survives the broker hop as a structured object', async () => {
    const worker = new ServiceBroker({
      nodeID: 'hub/provider-rtsp',
      transporter: 'Fake',
      logger: false,
    })
    await worker.start()
    await worker.waitForServices('$hub')
    setHubConnected()

    const ctx = await createAddonContext(
      worker,
      {
        id: 'provider-rtsp',
        capabilities: [],
      },
      '/tmp/log-e2e',
    )

    ctx.logger.error('stream failed', {
      meta: {
        url: 'rtsp://cam-1/main',
        attempts: 3,
        lastErr: 'connection refused',
        nested: { code: 'ECONNREFUSED' },
      },
    })
    await flushBroker()
    await worker.stop()

    const entry = destination.entries.find((e) => e.message === 'stream failed')
    expect(entry?.meta).toEqual({
      url: 'rtsp://cam-1/main',
      attempts: 3,
      lastErr: 'connection refused',
      nested: { code: 'ECONNREFUSED' },
    })
    // Message is untouched — no args/meta concatenation.
    expect(entry?.message).toBe('stream failed')
  })
})
