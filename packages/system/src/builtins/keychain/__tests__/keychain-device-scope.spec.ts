/**
 * A removed device takes its keychain values with it (D864). A device-scoped
 * secret is owned by the DRIVER that declared it (`secret://provider-dreame/
 * device/4483/navigationAccessCode`), so the device manager — which knows only
 * that the device is gone — needs one owner-spanning delete, and only it may
 * call it.
 */
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildKeySourceCandidates } from '../key-sources.js'
import { KeychainService } from '../keychain-service.js'
import { KeychainRepository } from '../keychain-store.js'
import { createKeychainUsageCheck } from '../keychain-usage.js'
import { MemoryDoor } from './memory-door.js'

const DREAME_CODE = 'secret://provider-dreame/device/4483/navigationAccessCode'
const HIKVISION_PASS = 'secret://provider-hikvision/device/4483/password'
const SIBLING = 'secret://provider-dreame/device/4484/navigationAccessCode'
const GLOBAL = 'secret://cloudflare-tunnel/global/customApiToken'

interface Harness {
  readonly service: KeychainService
  readonly events: Array<Record<string, unknown>>
}

let dataDir: string
let door: MemoryDoor

async function boot(): Promise<Harness> {
  const events: Array<Record<string, unknown>> = []
  const service = new KeychainService({
    repo: new KeychainRepository(door),
    candidates: async () => buildKeySourceCandidates({ config: {}, dataDir }),
    dataDir,
    events: { emit: (payload) => events.push({ ...payload }) },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    runnerIdOf: (id) => id,
    usage: createKeychainUsageCheck(door),
  })
  await service.init()
  await service.put('provider-dreame', DREAME_CODE, 'code-a')
  await service.put('provider-hikvision', HIKVISION_PASS, 'pass-b')
  await service.put('provider-dreame', SIBLING, 'code-c')
  await service.put('cloudflare-tunnel', GLOBAL, 'token-d')
  return { service, events }
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'keychain-device-scope-'))
  door = new MemoryDoor()
})

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true })
})

describe('deleteDeviceScope', () => {
  it('removes every owner’s device/<id> values and nothing else', async () => {
    const { service } = await boot()
    const removed = await service.deleteDeviceScope('device-manager', 4483)
    expect([...removed].sort()).toEqual([DREAME_CODE, HIKVISION_PASS].sort())
    const after = await service.listSecrets()
    expect(after.map((s) => s.ref).sort()).toEqual([GLOBAL, SIBLING].sort())
  })

  it('announces each deletion so every keeper drops its copy, and audits it', async () => {
    const { service, events } = await boot()
    events.length = 0
    await service.deleteDeviceScope('device-manager', 4483)
    expect(
      events
        .filter((e) => e['change'] === 'delete')
        .map((e) => e['ref'])
        .sort(),
    ).toEqual([DREAME_CODE, HIKVISION_PASS].sort())
    const deletes = (await service.listAudit(50)).filter((a) => a.action === 'delete')
    expect(deletes.map((a) => a.ref).sort()).toEqual([DREAME_CODE, HIKVISION_PASS].sort())
  })

  it('is reserved to the device manager', async () => {
    const { service } = await boot()
    await expect(service.deleteDeviceScope('provider-dreame', 4483)).rejects.toThrow()
    await expect(service.deleteDeviceScope(null, 4483)).rejects.toThrow()
    expect((await service.listSecrets()).length).toBe(4)
  })

  it('a device with no scoped secrets is a no-op', async () => {
    const { service } = await boot()
    expect(await service.deleteDeviceScope('device-manager', 9999)).toEqual([])
    expect((await service.listSecrets()).length).toBe(4)
  })
})
