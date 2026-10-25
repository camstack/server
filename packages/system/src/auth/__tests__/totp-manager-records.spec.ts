import { createRecordsAccess } from '@camstack/types'
import { generateSync } from 'otplib'
import { describe, expect, it } from 'vitest'
import { localAuthRecordKinds } from '../../builtins/local-auth/record-kinds.js'
import { makeRecordsWorld } from '../../builtins/sqlite-storage/__tests__/support/records-world.js'
import { TotpManager } from '../totp-manager.js'
import { fakeSecrets } from './fake-secrets.js'

describe('TotpManager — records path', () => {
  it('setup/confirm/verify without legacy user_totp collection', async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const secrets = fakeSecrets()
    const records = createRecordsAccess({
      owner: 'local-auth',
      transport: world.transportFor('local-auth'),
      secrets,
    })
    await records.declare(localAuthRecordKinds)
    const kind = records.kind(localAuthRecordKinds['user-totp'])
    const mgr = new TotpManager({ userTotpKind: kind }, { secrets })
    const { secret } = await mgr.setup('u-rec', 'alice')
    const code = generateSync({ secret })
    expect(await mgr.confirm('u-rec', code)).toBe(true)
    expect(await mgr.verify('u-rec', code)).toBe(true)
    const row = await kind.get('u-rec')
    expect(row?.data.confirmedAt).toEqual(expect.any(Number))
  })
})
