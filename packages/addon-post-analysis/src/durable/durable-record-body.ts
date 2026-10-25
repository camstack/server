/**
 * Zod body for phase-3 durable ledger record kinds. The engine validates on
 * write; each owner's `fromRecord` / `toValue` remain authoritative on read.
 */
import { z } from 'zod'

export const DurableLedgerBodySchema = z.record(z.string(), z.unknown())
export type DurableLedgerBody = z.infer<typeof DurableLedgerBodySchema>
