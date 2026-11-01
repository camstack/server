/**
 * D989: a server declares the shell and the addons it needs; `applyServerUpdate`
 * reads the declaration from the STAGED closure and refuses before it arms a
 * swap the node cannot live with.
 */
import type { PackageRequires } from '@camstack/types'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { readPendingRootSwap } from '../root-single-copy.js'
import { rootPackageDir } from '../root-state.js'
import { RootUpdateService, type NpmExecFn } from '../root-update-service.js'

let tmp: string
let dataDir: string
let seedDir: string
let restarts: string[]

const IN_CONTAINER = {
  platform: 'linux',
  dockerEnvFileExists: true,
  proc1Cgroup: '0::/docker/abc',
} as const

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-requires-'))
  dataDir = path.join(tmp, 'data')
  seedDir = path.join(tmp, 'seed')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(seedDir, { recursive: true })
  fs.writeFileSync(
    path.join(seedDir, 'package.json'),
    JSON.stringify({ name: '@camstack/server', version: '1.2.600' }),
  )
  fs.writeFileSync(
    path.join(tmp, 'running.json'),
    JSON.stringify({ name: '@camstack/server', version: '1.2.600' }),
  )
  restarts = []
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A valid staged closure whose package.json carries the given `camstack.requires`. */
function stageWith(version: string, requires: PackageRequires | undefined): NpmExecFn {
  return async (args, opts) => {
    if (args[0] !== 'install' || opts.cwd === undefined) return { stdout: '' }
    const pkgDir = rootPackageDir(opts.cwd, HUB_ROOT_SPEC)
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry')
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@camstack/server',
        version,
        ...(requires === undefined ? {} : { camstack: { requires } }),
      }),
    )
    for (const rel of [
      'better-sqlite3/build/Release/better_sqlite3.node',
      '@img/sharp-linux-x64/lib/sharp.node',
      '@seydx/node-av-linux-x64/av.node',
    ]) {
      const full = path.join(opts.cwd, 'node_modules', ...rel.split('/'))
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, 'ELF')
    }
    return { stdout: '' }
  }
}

function make(
  execNpm: NpmExecFn,
  extra: Partial<ConstructorParameters<typeof RootUpdateService>[0]> = {},
  env: NodeJS.ProcessEnv = {},
): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: { bootMode: 'T_BOOT', activeVersion: 'T_ACTIVE', seedDir: 'T_SEED' },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    restartServer: (reason) => restarts.push(reason),
    dataDir,
    runningPackageJsonPath: path.join(tmp, 'running.json'),
    workspaceProbeDir: tmp,
    execNpm,
    env: { T_BOOT: 'data-root', T_SEED: seedDir, ...env },
    readWrapperProbes: () => IN_CONTAINER,
    ...extra,
  })
}

describe('applyServerUpdate reads the staged closure requirements (D989)', () => {
  it('refuses a server that needs a newer shell, names both versions and arms nothing', async () => {
    const svc = make(stageWith('1.2.700', { wrapper: { image: '>=1.2.650' } }))
    const res = await svc.applyServerUpdate({ version: '1.2.700' })
    expect(res).toMatchObject({ accepted: false, outcome: 'refused', reason: 'requirements-unmet' })
    expect(res.unmet).toEqual([
      { kind: 'wrapper-too-old', wrapper: 'image', required: '1.2.650', running: '1.2.600' },
    ])
    expect(res.message).toContain('1.2.650')
    expect(res.message).toContain('1.2.600')
    expect(readPendingRootSwap(path.join(dataDir, 'server-root'))).toBeNull()
    expect(restarts).toEqual([])
  })

  it('accepts when the shell meets the minimum', async () => {
    const svc = make(stageWith('1.2.700', { wrapper: { image: '>=1.2.500' } }))
    const res = await svc.applyServerUpdate({ version: '1.2.700' })
    expect(res).toMatchObject({ accepted: true, outcome: 'staged' })
    expect(restarts).toHaveLength(1)
  })

  it('counts a shell that reports no version as below the minimum', async () => {
    fs.rmSync(path.join(seedDir, 'package.json'))
    const svc = make(stageWith('1.2.700', { wrapper: { image: '>=1.0.0' } }))
    const res = await svc.applyServerUpdate({ version: '1.2.700' })
    expect(res).toMatchObject({ accepted: false, reason: 'requirements-unmet' })
    expect(res.unmet).toEqual([
      { kind: 'wrapper-too-old', wrapper: 'image', required: '1.0.0', running: null },
    ])
  })

  it('returns the addons to update with the server', async () => {
    const svc = make(
      stageWith('1.2.700', {
        addons: { '@camstack/addon-a': '>=2.0.0', '@camstack/addon-b': '>=1.0.0' },
      }),
      {
        installedAddonVersions: () => ({
          '@camstack/addon-a': '1.9.0',
          '@camstack/addon-b': '1.0.0',
        }),
      },
    )
    const res = await svc.applyServerUpdate({ version: '1.2.700' })
    expect(res.accepted).toBe(true)
    expect(res.requiredAddonUpdates).toEqual([
      { packageName: '@camstack/addon-a', required: '2.0.0', installed: '1.9.0' },
    ])
  })

  it('stages a server that declares nothing', async () => {
    const svc = make(stageWith('1.2.700', undefined))
    const res = await svc.applyServerUpdate({ version: '1.2.700' })
    expect(res).toMatchObject({ accepted: true })
    expect(res.requiredAddonUpdates ?? []).toEqual([])
  })
})
