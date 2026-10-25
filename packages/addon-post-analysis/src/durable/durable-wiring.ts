/**
 * What a {@link DurableLedger} owner needs to reach its record kind: the
 * addon's `ctx.records` (every node has one), with the kinds already declared.
 */
import type { RecordsAccess } from '@camstack/types'

export interface DurableKindDeps {
  readonly records: Pick<RecordsAccess, 'kind'>
}
