import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import type { MatterConnection } from '../config.js'
import type { MatterController } from '../matter-controller.js'
import { boundPortFrom, MatterIntegrationManager } from '../matter-integration-manager.js'

interface Line {
  readonly level: string
  readonly message: string
  readonly meta: unknown
}

function recordingLogger(lines: Line[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, ctx?: { readonly meta?: unknown }): void => {
      lines.push({ level, message, meta: ctx?.meta })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const CONNECTION: MatterConnection = {
  threadDataset: '',
  wifiSsid: '',
  wifiPassword: '',
  reconcileIntervalMs: 60_000,
}

function failingController(message: string): MatterController {
  const notNeeded = async (): Promise<never> => {
    throw new Error('not used')
  }
  return {
    start: async () => {
      throw new Error(message)
    },
    stop: async () => undefined,
    commissionNode: notNeeded,
    listNodes: async () => [],
    getNode: async () => null,
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
    invokeCommand: notNeeded,
    removeNode: notNeeded,
    readAttributes: notNeeded,
    syncSubscriptions: async () => undefined,
  }
}

describe('a fabric that cannot bind the shared port', () => {
  it('reads the port out of the bind error', () => {
    expect(boundPortFrom('Cannot bind {::}:5540 because port is already in use')).toBe('5540')
    expect(boundPortFrom('Cannot bind to {::}:5540 (code EACCES)')).toBeNull()
    expect(boundPortFrom('something else')).toBeNull()
  })

  async function startWith(message: string): Promise<{ lines: Line[]; status: string }> {
    const lines: Line[] = []
    const manager = new MatterIntegrationManager({
      id: 'matter_001',
      name: 'legacy',
      connection: CONNECTION,
      dataDir: '/tmp/unused',
      logger: recordingLogger(lines),
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onNodesChanged: () => undefined,
      onAttributeReport: () => undefined,
      makeController: () => failingController(message),
    })
    await manager.start()
    return { lines, status: manager.getInfo().status }
  }

  it('logs once, with the fabric id and the plain reason', async () => {
    const { lines, status } = await startWith(
      'Cannot bind {::}:5540 because port is already in use',
    )
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toContain('matter_001')
    expect(warns[0]?.message).toContain('another fabric of this addon already holds port 5540')
    expect(status).toBe('error')
  })

  it('keeps the real message, with its code, for any other bind failure', async () => {
    const { lines } = await startWith('Cannot bind to {::}:5540 (code EACCES)')
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).not.toContain('already holds')
    expect(JSON.stringify(warns[0]?.meta)).toContain('code EACCES')
  })
})
