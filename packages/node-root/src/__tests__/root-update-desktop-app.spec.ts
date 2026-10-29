/**
 * The desktop app channel as the node sees it (ADR-0971): the app's state file
 * becomes `desktopApp` on the status, and `installDesktopUpdate` writes the
 * request file ONLY when the app's own state says something is downloaded.
 *
 * Behavioural: real files in a temp data dir, the real service.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  consumeDesktopInstallRequest,
  DESKTOP_APP_STATE_STALE_MS,
  desktopAppStatePath,
  desktopInstallRequestPath,
  writeDesktopAppState,
  type DesktopAppStateFile,
} from '../desktop-app-channel.js'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { serverRootDir } from '../root-state.js'
import {
  RootUpdateService,
  type RootUpdateEnvNames,
  type RootUpdateLogger,
} from '../root-update-service.js'
import type { WrapperProbeReadings } from '../wrapper-identity.js'

const ENV_NAMES: RootUpdateEnvNames = {
  bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
  activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
  seedDir: 'CAMSTACK_SEED_SERVER_DIR',
}

const SILENT: RootUpdateLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const ON_A_MAC: WrapperProbeReadings = {
  platform: 'darwin',
  dockerEnvFileExists: false,
  proc1Cgroup: null,
}

const NOW = 2_000_000_000_000

let tmp: string
let dataDir: string
let rootDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-update-desktop-'))
  dataDir = path.join(tmp, 'data')
  rootDir = serverRootDir(dataDir)
  fs.mkdirSync(rootDir, { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'running.json'),
    JSON.stringify({ name: '@camstack/server', version: '1.2.32' }),
    'utf-8',
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeService(env: NodeJS.ProcessEnv): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: ENV_NAMES,
    nodeId: 'agent-a',
    logger: SILENT,
    restartServer: () => undefined,
    dataDir,
    runningPackageJsonPath: path.join(tmp, 'running.json'),
    workspaceProbeDir: tmp,
    execNpm: async () => ({ stdout: '' }),
    env,
    readWrapperProbes: () => ON_A_MAC,
    now: () => NOW,
  })
}

const ELECTRON_ENV: NodeJS.ProcessEnv = { CAMSTACK_AGENT_APP_VERSION: '2.0.0' }

function appState(over: Partial<DesktopAppStateFile> = {}): DesktopAppStateFile {
  return {
    appVersion: '2.0.0',
    available: true,
    downloaded: true,
    version: '2.1.0',
    checking: false,
    error: null,
    updatedAtMs: NOW - 1_000,
    ...over,
  }
}

describe('getServerPackageStatus.desktopApp', () => {
  it('is absent when the app never wrote a state file', async () => {
    const status = await makeService(ELECTRON_ENV).getServerPackageStatus()
    expect(status.desktopApp).toBeUndefined()
  })

  it('carries the app version and update facts from the state file', async () => {
    writeDesktopAppState(rootDir, appState({ error: 'feed 404' }))
    const status = await makeService(ELECTRON_ENV).getServerPackageStatus()
    expect(status.desktopApp).toEqual({
      version: '2.0.0',
      update: {
        available: true,
        downloaded: true,
        version: '2.1.0',
        checking: false,
        error: 'feed 404',
      },
      stateAtMs: NOW - 1_000,
      stale: false,
    })
  })

  it('reports an old file as stale instead of dropping it or reading it as "no update"', async () => {
    writeDesktopAppState(rootDir, appState({ updatedAtMs: NOW - DESKTOP_APP_STATE_STALE_MS - 1 }))
    const status = await makeService(ELECTRON_ENV).getServerPackageStatus()
    expect(status.desktopApp?.stale).toBe(true)
    expect(status.desktopApp?.update.downloaded).toBe(true)
  })

  it('reads a malformed file as absent', async () => {
    fs.writeFileSync(desktopAppStatePath(rootDir), '{"appVersion": 3', 'utf-8')
    const status = await makeService(ELECTRON_ENV).getServerPackageStatus()
    expect(status.desktopApp).toBeUndefined()
  })
})

describe('installDesktopUpdate', () => {
  it('writes a request the app can consume once when an update is downloaded', () => {
    writeDesktopAppState(rootDir, appState())
    const result = makeService(ELECTRON_ENV).installDesktopUpdate()
    expect(result).toEqual({ accepted: true, reason: null })
    const request = consumeDesktopInstallRequest(rootDir, NOW)
    expect(request?.requestedAtMs).toBe(NOW)
    expect(request?.nonce.length).toBeGreaterThan(0)
    expect(fs.existsSync(desktopInstallRequestPath(rootDir))).toBe(false)
  })

  it('refuses when nothing is downloaded and writes no request', () => {
    writeDesktopAppState(rootDir, appState({ downloaded: false }))
    const result = makeService(ELECTRON_ENV).installDesktopUpdate()
    expect(result).toEqual({ accepted: false, reason: 'not-downloaded' })
    expect(fs.existsSync(desktopInstallRequestPath(rootDir))).toBe(false)
  })

  it('refuses when the app state is stale', () => {
    writeDesktopAppState(rootDir, appState({ updatedAtMs: NOW - DESKTOP_APP_STATE_STALE_MS - 1 }))
    const result = makeService(ELECTRON_ENV).installDesktopUpdate()
    expect(result).toEqual({ accepted: false, reason: 'app-state-stale' })
    expect(fs.existsSync(desktopInstallRequestPath(rootDir))).toBe(false)
  })

  it('refuses when the app never published its state', () => {
    const result = makeService(ELECTRON_ENV).installDesktopUpdate()
    expect(result).toEqual({ accepted: false, reason: 'no-app-state' })
  })

  it('refuses when the node is not inside the desktop app', () => {
    writeDesktopAppState(rootDir, appState())
    const result = makeService({}).installDesktopUpdate()
    expect(result).toEqual({ accepted: false, reason: 'not-electron' })
    expect(fs.existsSync(desktopInstallRequestPath(rootDir))).toBe(false)
  })
})
