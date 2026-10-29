import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverRootDir, writeDesktopAppState } from '../../../server-root/index.js'
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

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-desktop-announce-'))
  fs.writeFileSync(
    path.join(tmp, 'running.json'),
    JSON.stringify({ name: '@camstack/server', version: '1.2.32' }),
    'utf-8',
  )
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the hub announces its desktop shell updating itself', () => {
  it('emits system.restarting naming the shell, both versions and the node', () => {
    const emit = vi.fn<(event: SystemEvent) => void>()
    const now = Date.now()
    writeDesktopAppState(serverRootDir(tmp), {
      appVersion: '1.2.10',
      available: true,
      downloaded: true,
      version: '1.2.11',
      checking: false,
      error: null,
      updatedAtMs: now,
    })
    const service = new ServerUpdateService({
      logger: logger(),
      restartServer: () => undefined,
      dataDir: tmp,
      runningPackageJsonPath: path.join(tmp, 'running.json'),
      env: { CAMSTACK_AGENT_APP_VERSION: '1.2.10', CAMSTACK_NODE_ID: 'hub' },
      readWrapperProbes: () => ({
        platform: 'darwin',
        dockerEnvFileExists: false,
        proc1Cgroup: null,
      }),
      now: () => now,
      eventBus: { emit } as unknown as IEventBus,
    })

    expect(service.installDesktopUpdate().accepted).toBe(true)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0]).toMatchObject({
      category: 'system.restarting',
      data: {
        kind: 'framework-update',
        what: 'desktop-shell',
        packageName: 'CamStack desktop app',
        fromVersion: '1.2.10',
        toVersion: '1.2.11',
        nodeId: 'hub',
      },
    })
  })
})
