/**
 * `server-management.installDesktopUpdate` through the PROVIDER trampoline —
 * the same builder backs the hub and every agent, so this is the per-node
 * route. The real `RootUpdateService` runs over a temp data dir; the app side
 * of the channel is played by writing/consuming the real files.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  consumeDesktopInstallRequest,
  HUB_ROOT_SPEC,
  RootUpdateService,
  serverRootDir,
  writeDesktopAppState,
  type DesktopAppStateFile,
  type RootUpdateLogger,
} from '../../../server-root/index.js'
import { buildServerManagementProvider } from '../server-management.provider.js'

const NOW = 1_800_000_000_000

const SILENT: RootUpdateLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

let tmp: string
let dataDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-desktop-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(serverRootDir(dataDir), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'running.json'),
    JSON.stringify({ name: '@camstack/server', version: '1.2.0' }),
    'utf-8',
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function providerFor(env: NodeJS.ProcessEnv) {
  const service = new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: {
      bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
      activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
      seedDir: 'CAMSTACK_SEED_SERVER_DIR',
    },
    nodeId: 'win-agent',
    logger: SILENT,
    restartServer: () => undefined,
    dataDir,
    runningPackageJsonPath: path.join(tmp, 'running.json'),
    workspaceProbeDir: tmp,
    execNpm: async () => ({ stdout: '' }),
    env,
    readWrapperProbes: () => ({ platform: 'win32', dockerEnvFileExists: false, proc1Cgroup: null }),
    now: () => NOW,
  })
  const provider = buildServerManagementProvider(service, dataDir)
  if (provider === null) throw new Error('provider expected')
  return provider
}

function state(over: Partial<DesktopAppStateFile>): DesktopAppStateFile {
  return {
    appVersion: '2.0.0',
    available: true,
    downloaded: true,
    version: '2.1.0',
    checking: false,
    error: null,
    updatedAtMs: NOW - 5_000,
    ...over,
  }
}

describe('installDesktopUpdate via the server-management provider', () => {
  const ELECTRON = { CAMSTACK_AGENT_APP_VERSION: '2.0.0' }

  it('hands the app a consumable request when its update is downloaded', async () => {
    writeDesktopAppState(serverRootDir(dataDir), state({}))
    const result = await providerFor(ELECTRON).installDesktopUpdate()
    expect(result).toEqual({ accepted: true, reason: null })
    expect(consumeDesktopInstallRequest(serverRootDir(dataDir), NOW)).not.toBeNull()
  })

  it('refuses without writing when the update is not downloaded', async () => {
    writeDesktopAppState(serverRootDir(dataDir), state({ downloaded: false }))
    const result = await providerFor(ELECTRON).installDesktopUpdate()
    expect(result).toEqual({ accepted: false, reason: 'not-downloaded' })
    expect(consumeDesktopInstallRequest(serverRootDir(dataDir), NOW)).toBeNull()
  })

  it('serves desktopApp on the status of the same provider', async () => {
    writeDesktopAppState(serverRootDir(dataDir), state({}))
    const status = await providerFor(ELECTRON).getServerPackageStatus()
    expect(status.desktopApp?.update.downloaded).toBe(true)
    expect(status.desktopApp?.stale).toBe(false)
  })
})
