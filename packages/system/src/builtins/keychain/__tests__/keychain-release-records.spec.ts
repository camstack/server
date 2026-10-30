/**
 * The engine drops a record kind (stale-data audit, D905) and the values its rows
 * held go with it. Only `sqlite-settings` may release them, and only refs scoped
 * `row/records:<kind>/...`: the one owner-spanning delete is narrow on purpose.
 */
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { recordSecretRef } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildKeySourceCandidates } from '../key-sources.js'
import { KeychainService } from '../keychain-service.js'
import { KeychainRepository } from '../keychain-store.js'
import { createKeychainUsageCheck } from '../keychain-usage.js'
import { MemoryDoor } from './memory-door.js'

const ROW_REF = recordSecretRef('gone-addon', 'tokens', 'row-1', 'token')
const OTHER_ROW_REF = recordSecretRef('live-addon', 'tokens', 'row-9', 'token')
const GLOBAL = 'secret://cloudflare-tunnel/global/customApiToken'

let dataDir: string
let door: MemoryDoor

async function boot(): Promise<KeychainService> {
  const service = new KeychainService({
    repo: new KeychainRepository(door),
    candidates: async () => buildKeySourceCandidates({ config: {}, dataDir }),
    dataDir,
    events: { emit: () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    runnerIdOf: (id) => id,
    usage: createKeychainUsageCheck(door),
  })
  await service.init()
  await service.put('gone-addon', ROW_REF, 'row-secret')
  await service.put('live-addon', OTHER_ROW_REF, 'other-secret')
  await service.put('cloudflare-tunnel', GLOBAL, 'token-d')
  return service
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'keychain-release-records-'))
  door = new MemoryDoor()
})

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true })
})

describe('releaseRecordRefs', () => {
  it('removes the named record-row values and audits the operator it acted for', async () => {
    const service = await boot()
    expect(await service.releaseRecordRefs('sqlite-settings', [ROW_REF], 'user-7')).toBe(1)
    const left = (await service.listSecrets()).map((s) => s.ref).sort()
    expect(left).toEqual([GLOBAL, OTHER_ROW_REF].sort())
    const audit = (await service.listAudit(50)).find(
      (a) => a.action === 'delete' && a.ref === ROW_REF,
    )
    expect(audit?.actor).toBe('user:user-7')
  })

  it('is reserved to sqlite-settings', async () => {
    const service = await boot()
    await expect(service.releaseRecordRefs('gone-addon', [ROW_REF], 'u')).rejects.toThrow()
    await expect(service.releaseRecordRefs('device-manager', [ROW_REF], 'u')).rejects.toThrow()
    await expect(service.releaseRecordRefs(null, [ROW_REF], 'u')).rejects.toThrow()
    expect((await service.listSecrets()).length).toBe(3)
  })

  it('refuses a ref that is not a record-row value, and deletes nothing of the batch', async () => {
    const service = await boot()
    await expect(
      service.releaseRecordRefs('sqlite-settings', [ROW_REF, GLOBAL], 'u'),
    ).rejects.toThrow()
    expect((await service.listSecrets()).length).toBe(3)
  })

  it('a ref that holds no value is a no-op', async () => {
    const service = await boot()
    const missing = recordSecretRef('gone-addon', 'tokens', 'nobody', 'token')
    expect(await service.releaseRecordRefs('sqlite-settings', [missing], 'u')).toBe(0)
  })
})
