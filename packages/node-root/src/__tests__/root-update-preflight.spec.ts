/**
 * D877: the update pre-flight and the runner boot check on the status.
 *
 * 2026-10-17 a hub applied a version whose boot guard refused 28 addons on the
 * unmigrated store. The update was accepted, swapped and restarted, and the
 * addons stayed down for four hours. The engine now asks BEFORE staging.
 */
import type { RunnerBootCheck, UpdateBlocker } from '@camstack/types'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { RootUpdateService, type NpmExecFn } from '../root-update-service.js'

let tmp: string
let npmCalls: string[][]
let restarts: string[]

const BLOCKER: UpdateBlocker = {
  addonId: 'auth',
  reason: 'the target would refuse its settings',
  remedy: 'Run the fixture remedy script.',
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-preflight-'))
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'pkg.json'),
    JSON.stringify({ name: '@camstack/server', version: '1.2.500' }),
  )
  npmCalls = []
  restarts = []
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const execNpm: NpmExecFn = async (args) => {
  npmCalls.push([...args])
  throw new Error('staging reached') // the pre-flight must stop us before this
}

function make(
  extra: Partial<ConstructorParameters<typeof RootUpdateService>[0]>,
): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: {
      bootMode: 'T_BOOT',
      activeVersion: 'T_ACTIVE',
      seedDir: 'T_SEED',
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    restartServer: (reason) => restarts.push(reason),
    dataDir: path.join(tmp, 'data'),
    runningPackageJsonPath: path.join(tmp, 'pkg.json'),
    workspaceProbeDir: tmp,
    execNpm,
    env: { T_BOOT: 'data-root' },
    ...extra,
  })
}

describe('applyServerUpdate pre-flight (D877)', () => {
  it('refuses, names the addons and the remedy, and stages nothing', async () => {
    const asked: string[] = []
    const svc = make({
      updatePreflight: async (target) => {
        asked.push(target)
        return [BLOCKER]
      },
    })
    const res = await svc.applyServerUpdate({ version: '1.2.585' })
    expect(res).toMatchObject({
      accepted: false,
      outcome: 'refused',
      reason: 'addon-would-refuse',
      blockers: [BLOCKER],
    })
    expect(res.message).toContain('auth')
    expect(res.message).toContain('fixture remedy')
    expect(asked).toEqual(['1.2.585'])
    expect(npmCalls).toHaveLength(0)
    expect(restarts).toHaveLength(0)
  })

  it('an explicit acknowledgement goes on to stage', async () => {
    const svc = make({ updatePreflight: async () => [BLOCKER] })
    const res = await svc.applyServerUpdate({ version: '1.2.585', acknowledgeRefusals: true })
    expect(res.reason).not.toBe('addon-would-refuse')
    expect(npmCalls.length).toBeGreaterThan(0)
  })

  it('a pre-flight that cannot ask does not freeze updates', async () => {
    const svc = make({
      updatePreflight: async () => {
        throw new Error('store unreachable')
      },
    })
    const res = await svc.applyServerUpdate({ version: '1.2.585' })
    expect(res.reason).not.toBe('addon-would-refuse')
    expect(npmCalls.length).toBeGreaterThan(0)
  })

  it('serves the runner boot check on the status, and omits it until it exists', async () => {
    let check: RunnerBootCheck | undefined
    const svc = make({ runnerBootCheck: () => check })
    expect((await svc.getServerPackageStatus()).runners).toBeUndefined()
    check = {
      checkedAtMs: 1,
      expected: 3,
      running: 1,
      failed: ['a'],
      refused: [{ runnerId: 'b', addonIds: ['b'], reason: 'x' }],
      missing: [],
      planKnown: true,
    }
    expect((await svc.getServerPackageStatus()).runners).toEqual(check)
  })
})
