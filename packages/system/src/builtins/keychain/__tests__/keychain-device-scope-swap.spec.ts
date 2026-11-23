/**
 * A migration exchanges two devices' keychain scopes (D339 amendment). A
 * ciphertext is bound to its ref (the ref is the AAD), so "moving" a value
 * between `device/3628` and `device/5920` is a re-encrypt under the new ref —
 * and the two scopes swap, so each number ends up holding the secrets of the
 * hardware its config now describes. Without it, removing the leftover device
 * ran `deleteDeviceScope` over the password the migrated camera reads.
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

const NVR_PASS_AT_A = 'secret://provider-reolink/device/3628/password'
const CAM_PASS_AT_B = 'secret://provider-reolink/device/5920/password'
const EXTRA_AT_A = 'secret://provider-reolink/device/3628/nvrToken'
const OTHER = 'secret://provider-reolink/device/7000/password'

let dataDir: string
let door: MemoryDoor

async function boot(): Promise<{
  service: KeychainService
  events: Array<Record<string, unknown>>
}> {
  const events: Array<Record<string, unknown>> = []
  const service = new KeychainService({
    repo: new KeychainRepository(door),
    candidates: () =>
      buildKeySourceCandidates({ dataDir, secretsDir: path.join(dataDir, 'run-secrets') }),
    dataDir,
    events: { emit: (payload) => events.push({ ...payload }) },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    runnerIdOf: (id) => id,
    usage: createKeychainUsageCheck(door),
  })
  await service.init()
  await service.put('provider-reolink', NVR_PASS_AT_A, 'nvr-login')
  await service.put('provider-reolink', CAM_PASS_AT_B, 'camera-own')
  await service.put('provider-reolink', EXTRA_AT_A, 'nvr-token')
  await service.put('provider-reolink', OTHER, 'unrelated')
  return { service, events }
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'keychain-scope-swap-'))
  door = new MemoryDoor()
})

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true })
})

describe('swapDeviceScopes', () => {
  it('each scope ends up holding the other’s values, readable under the new ref', async () => {
    const { service } = await boot()

    await service.swapDeviceScopes('device-manager', 3628, 5920)

    const read = await service.resolve('provider-reolink', [
      NVR_PASS_AT_A,
      CAM_PASS_AT_B,
      EXTRA_AT_A,
      OTHER,
    ])
    expect(read[NVR_PASS_AT_A]).toMatchObject({ kind: 'value', value: 'camera-own' })
    expect(read[CAM_PASS_AT_B]).toMatchObject({ kind: 'value', value: 'nvr-login' })
    expect(read[OTHER]).toMatchObject({ kind: 'value', value: 'unrelated' })
  })

  it('a field only one side has moves with the scope and leaves nothing behind', async () => {
    const { service } = await boot()

    await service.swapDeviceScopes('device-manager', 3628, 5920)

    const refs = (await service.listSecrets()).map((s) => s.ref).sort()
    expect(refs).toEqual(
      [
        NVR_PASS_AT_A,
        CAM_PASS_AT_B,
        OTHER,
        'secret://provider-reolink/device/5920/nvrToken',
      ].sort(),
    )
    const moved = await service.resolve('provider-reolink', [
      'secret://provider-reolink/device/5920/nvrToken',
    ])
    expect(moved['secret://provider-reolink/device/5920/nvrToken']).toMatchObject({
      kind: 'value',
      value: 'nvr-token',
    })
  })

  it('reports what each scope now holds, refs only', async () => {
    const { service } = await boot()

    const report = await service.swapDeviceScopes('device-manager', 3628, 5920)

    expect([...report.refsNowAtA].sort()).toEqual([NVR_PASS_AT_A])
    expect([...report.refsNowAtB].sort()).toEqual(
      [CAM_PASS_AT_B, 'secret://provider-reolink/device/5920/nvrToken'].sort(),
    )
  })

  it('swapping twice restores the original arrangement', async () => {
    const { service } = await boot()

    await service.swapDeviceScopes('device-manager', 3628, 5920)
    await service.swapDeviceScopes('device-manager', 3628, 5920)

    const read = await service.resolve('provider-reolink', [NVR_PASS_AT_A, CAM_PASS_AT_B])
    expect(read[NVR_PASS_AT_A]).toMatchObject({ value: 'nvr-login' })
    expect(read[CAM_PASS_AT_B]).toMatchObject({ value: 'camera-own' })
  })

  it('is reserved to the device manager', async () => {
    const { service } = await boot()
    await expect(service.swapDeviceScopes('provider-reolink', 3628, 5920)).rejects.toThrow()
    await expect(service.swapDeviceScopes(null, 3628, 5920)).rejects.toThrow()
    const read = await service.resolve('provider-reolink', [NVR_PASS_AT_A])
    expect(read[NVR_PASS_AT_A]).toMatchObject({ value: 'nvr-login' })
  })

  it('announces each changed ref and audits it, never a value', async () => {
    const { service, events } = await boot()
    events.length = 0

    await service.swapDeviceScopes('device-manager', 3628, 5920)

    expect(events.every((e) => !JSON.stringify(e).includes('nvr-login'))).toBe(true)
    expect(events.map((e) => e['ref'])).toContain(CAM_PASS_AT_B)
    const audit = (await service.listAudit(50)).filter((a) => a.detail === 'device-scope-swap')
    expect(audit.length).toBeGreaterThan(0)
  })

  it('two scopes with no values is a no-op', async () => {
    const { service } = await boot()
    expect(await service.swapDeviceScopes('device-manager', 9001, 9002)).toEqual({
      refsNowAtA: [],
      refsNowAtB: [],
    })
  })

  it('refuses a device swapped with itself', async () => {
    const { service } = await boot()
    await expect(service.swapDeviceScopes('device-manager', 3628, 3628)).rejects.toThrow(/same/)
  })
})
