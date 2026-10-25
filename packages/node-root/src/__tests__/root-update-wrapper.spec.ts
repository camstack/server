/**
 * `getServerPackageStatus` reports the SHELL, not just the code.
 *
 * `runningVersion` can be perfectly current while the container is weeks old
 * (2026-08-02) — `imageContract` says the image is behind, and this says WHAT
 * the image is, so the operator can be told HOW to converge. The two travel on
 * the same payload because they answer the same question from two sides.
 *
 * These are behavioural: the service is driven with real probe readings and
 * the payload is asserted. Nothing here type-checks a field into existence.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import {
  readWrapperProbes,
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

const IN_CONTAINER: WrapperProbeReadings = {
  platform: 'linux',
  dockerEnvFileExists: true,
  proc1Cgroup: '0::/system.slice/docker-9f2c1b7d5e4a.scope\n',
}

const ON_A_MAC: WrapperProbeReadings = {
  platform: 'darwin',
  dockerEnvFileExists: false,
  proc1Cgroup: null,
}

let tmp: string
let dataDir: string
let seedDir: string
let runningPkgPath: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-update-wrapper-'))
  dataDir = path.join(tmp, 'data')
  seedDir = path.join(tmp, 'seed')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(seedDir, { recursive: true })
  fs.writeFileSync(
    path.join(seedDir, 'package.json'),
    JSON.stringify({ name: '@camstack/server', version: '1.1.74' }),
    'utf-8',
  )
  runningPkgPath = path.join(tmp, 'running-package.json')
  fs.writeFileSync(
    runningPkgPath,
    JSON.stringify({ name: '@camstack/server', version: '1.2.32' }),
    'utf-8',
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeService(env: NodeJS.ProcessEnv, probes: WrapperProbeReadings): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: ENV_NAMES,
    nodeId: 'hub',
    logger: SILENT,
    restartServer: () => undefined,
    dataDir,
    runningPackageJsonPath: runningPkgPath,
    workspaceProbeDir: tmp,
    execNpm: async () => ({ stdout: '' }),
    env,
    readWrapperProbes: () => probes,
  })
}

describe('readWrapperProbes', () => {
  it('reports the real platform and never turns an unreadable probe into an empty answer', () => {
    const probes = readWrapperProbes()

    expect(probes.platform).toBe(process.platform)
    // `''` would read as "checked, no container" and earn a node the `native`
    // verdict it did not earn. A read that failed is `null`.
    expect(probes.proc1Cgroup === null || probes.proc1Cgroup.length > 0).toBe(true)
    // On a developer Mac the probe genuinely cannot answer — and that is the
    // case `unknown` exists for, not a case to paper over.
    if (process.platform !== 'linux') expect(probes.dockerEnvFileExists).toBe(false)
  })
})

describe('getServerPackageStatus carries the wrapper identity', () => {
  it('reports the 2026-08-02 hub as a docker shell fingerprinted by its seed', async () => {
    const service = makeService({ CAMSTACK_SEED_SERVER_DIR: seedDir }, IN_CONTAINER)

    const status = await service.getServerPackageStatus()

    expect(status.wrapper?.kind).toBe('docker')
    // The shell's version is the SEED — the one image fingerprint readable
    // from inside — not `runningVersion`, which applyServerUpdate keeps
    // current on a container weeks out of date.
    expect(status.wrapper?.currentVersion).toBe('1.1.74')
    expect(status.runningVersion).toBe('1.2.32')
  })

  it('reports the mac agent as native, and its evidence names the platform it excluded on', async () => {
    const service = makeService({ CAMSTACK_SEED_SERVER_DIR: seedDir }, ON_A_MAC)

    const status = await service.getServerPackageStatus()

    expect(status.wrapper?.kind).toBe('native')
    const platformRow = status.wrapper?.evidence.find((row) => row.fact === 'platform')
    expect(platformRow?.detail).toContain('darwin')
  })

  it('reports the electron shell from the version its main process declared', async () => {
    const service = makeService(
      { CAMSTACK_SEED_SERVER_DIR: seedDir, CAMSTACK_AGENT_APP_VERSION: '1.4.2' },
      ON_A_MAC,
    )

    const status = await service.getServerPackageStatus()

    expect(status.wrapper?.kind).toBe('electron')
    expect(status.wrapper?.currentVersion).toBe('1.4.2')
  })

  it('reports the contradiction when an electron env turns up inside a container', async () => {
    const service = makeService(
      { CAMSTACK_SEED_SERVER_DIR: seedDir, CAMSTACK_AGENT_APP_VERSION: '1.4.2' },
      IN_CONTAINER,
    )

    const status = await service.getServerPackageStatus()

    expect(status.wrapper?.kind).toBe('contradictory')
    expect(status.wrapper?.currentVersion).toBeNull()
  })
})
