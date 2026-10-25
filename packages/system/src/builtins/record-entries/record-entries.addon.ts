/**
 * `record-entries` - the generic entries surface (D881). Hub-only and
 * in-process: it acts for each entry's owner on the keychain and on the
 * records door, which only a hub in-process system builtin may do
 * (`ctx.records.forOwner`, `ctx.secrets.forOwner`).
 */
import {
  BaseAddon,
  type IRecordEntriesProvider,
  type ProviderRegistration,
  recordEntriesCapability,
} from '@camstack/types'
import { EntriesService } from './entries-service.js'

export class RecordEntriesAddon extends BaseAddon {
  readonly id = 'record-entries'

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const ctx = this.ctx
    const records = ctx.records
    const forOwner = records?.forOwner ?? null
    if (records === undefined || forOwner === null) {
      throw new Error(
        'record-entries: this process cannot act for another owner (hub in-process only)',
      )
    }
    const service = new EntriesService({
      listKinds: async (counts) => (await ctx.api.storageAdmin.listKinds.query({ counts })).kinds,
      recordsFor: (owner) => forOwner(owner),
    })
    const provider: IRecordEntriesProvider = {
      listEntryKinds: () => service.listEntryKinds(),
      listEntries: (input) => service.listEntries(input),
      putEntry: (input) => service.putEntry(input),
      deleteEntry: (input) => service.deleteEntry(input),
    }
    return [{ capability: recordEntriesCapability, provider }]
  }
}

export default RecordEntriesAddon
