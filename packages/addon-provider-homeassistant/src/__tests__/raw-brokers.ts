import { type RecordKindHandle, type RecordsAccess } from '@camstack/types'
import { z } from 'zod'
import { haBrokersEntryKind } from '../broker-record-kinds.js'

/** The `brokers` kind read as stored: fixtures plant fields the current schema no longer names. */
export function rawBrokers(
  records: Pick<RecordsAccess, 'kind'>,
): RecordKindHandle<Record<string, unknown>> {
  return records.kind({
    name: haBrokersEntryKind.name,
    declaration: haBrokersEntryKind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
}
