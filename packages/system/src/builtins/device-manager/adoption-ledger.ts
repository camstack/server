/**
 * What the device manager remembers about adoption (D1090): the adopt mode of
 * each integration instance, and one record per adopted candidate saying who
 * adopted it and whether the source still offers it.
 *
 * Behind a small interface so the auto-adopt logic is exercised without a
 * database; {@link RecordsAdoptionLedger} is the real one.
 */
import type { AdoptionRecord, AdoptMode, RecordKindHandle, RecordsAccess } from '@dominevo/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { deviceManagerRecordKinds, type AdoptionModeBody } from './record-kinds.js'

export interface AdoptionLedger {
  getMode(addonId: string, integrationId: string): Promise<AdoptMode | null>
  setMode(addonId: string, integrationId: string, adoptMode: AdoptMode): Promise<void>
  /** Every record of an addon, narrowed to one integration when given. */
  listRecords(addonId: string, integrationId?: string): Promise<readonly AdoptionRecord[]>
  putRecord(record: AdoptionRecord): Promise<void>
}

export function modeKey(addonId: string, integrationId: string): string {
  return `${addonId}::${integrationId}`
}

export function recordKey(
  record: Pick<AdoptionRecord, 'addonId' | 'integrationId' | 'childNativeId' | 'filter'>,
): string {
  return `${record.addonId}::${record.integrationId}::${record.filter ?? ''}::${record.childNativeId}`
}

export class RecordsAdoptionLedger implements AdoptionLedger {
  constructor(
    private readonly records: RecordKindHandle<AdoptionRecord>,
    private readonly modes: RecordKindHandle<AdoptionModeBody>,
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>): RecordsAdoptionLedger {
    return new RecordsAdoptionLedger(
      records.kind(deviceManagerRecordKinds['adoption-records']),
      records.kind(deviceManagerRecordKinds['adoption-modes']),
    )
  }

  async getMode(addonId: string, integrationId: string): Promise<AdoptMode | null> {
    const row = await this.modes.get(modeKey(addonId, integrationId))
    return row === null ? null : row.data.adoptMode
  }

  async setMode(addonId: string, integrationId: string, adoptMode: AdoptMode): Promise<void> {
    await this.modes.put({
      id: modeKey(addonId, integrationId),
      data: { addonId, integrationId, adoptMode },
    })
  }

  async listRecords(addonId: string, integrationId?: string): Promise<readonly AdoptionRecord[]> {
    const rows = await readAllRows(this.records)
    return rows
      .map((row) => row.data)
      .filter(
        (r) =>
          r.addonId === addonId &&
          (integrationId === undefined || r.integrationId === integrationId),
      )
  }

  async putRecord(record: AdoptionRecord): Promise<void> {
    await this.records.put({ id: recordKey(record), data: record })
  }
}
