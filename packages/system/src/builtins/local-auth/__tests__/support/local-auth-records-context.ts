import { createRecordsAccess, type AddonContext, type RecordsAccess } from '@camstack/types'
import {
  makeRecordsWorld,
  type RecordsWorld,
} from '../../../sqlite-storage/__tests__/support/records-world.js'

export interface LocalAuthRecordsFixture {
  readonly ctx: AddonContext
  readonly records: RecordsAccess
  readonly world: RecordsWorld
}

/** Attach a real in-memory `ctx.records` for local-auth addon integration specs. */
export async function withLocalAuthRecords(ctx: AddonContext): Promise<LocalAuthRecordsFixture> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const secrets =
    ctx.secrets?.forOwner?.('local-auth') ??
    ctx.secrets?.forOwner?.('system') ??
    ctx.secrets ??
    null
  const records = createRecordsAccess({
    owner: 'local-auth',
    transport: world.transportFor('local-auth'),
    secrets,
  })
  return { ctx: { ...ctx, records }, records, world }
}
