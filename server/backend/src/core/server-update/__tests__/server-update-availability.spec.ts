import * as path from 'node:path'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ServerUpdateService } from '../server-update.service.js'

function logger(): IScopedLogger {
  const instance: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => instance,
    withTags: () => instance,
  }
  return instance
}

describe('ServerUpdateService availability event', () => {
  it('emits once when repeated checks find the same newer server version', async () => {
    const emit = vi.fn<(event: SystemEvent) => void>()
    const runningPackageJsonPath = path.resolve(__dirname, '../../../../package.json')
    const service = new ServerUpdateService({
      logger: logger(),
      restartServer: () => undefined,
      dataDir: path.resolve(__dirname, '..'),
      runningPackageJsonPath,
      env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
      execNpm: async () => ({ stdout: '99.0.0\n' }),
      eventBus: { emit } as unknown as IEventBus,
    })

    await service.checkServerUpdate()
    await service.checkServerUpdate()

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0]).toMatchObject({
      category: 'update.available',
      data: {
        target: 'server',
        packageName: '@camstack/server',
        latestVersion: '99.0.0',
      },
    })
  })
})
