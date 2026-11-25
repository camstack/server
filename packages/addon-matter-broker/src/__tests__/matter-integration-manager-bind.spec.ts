import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import type { MatterConnection } from '../config.js'
import type { MatterController } from '../matter-controller.js'
import { boundPortFrom, MatterIntegrationManager } from '../matter-integration-manager.js'

interface Line {
  readonly level: string
  readonly message: string
}

function recordingLogger(lines: Line[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string): void => {
      lines.push({ level, message })
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
    syncSubscriptions: async () => undefined,
  }
}

describe('a fabric that cannot bind the shared port', () => {
  it('reads the port out of the bind error', () => {
    expect(boundPortFrom('Cannot bind {::}:5540')).toBe('5540')
    expect(boundPortFrom('something else')).toBeNull()
  })

  it('logs once, with the fabric id and the plain reason', async () => {
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
      makeController: () => failingController('Cannot bind {::}:5540'),
    })
    await manager.start()
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toContain('matter_001')
    expect(warns[0]?.message).toContain('another fabric of this addon already holds port 5540')
    expect(manager.getInfo().status).toBe('error')
  })
})
