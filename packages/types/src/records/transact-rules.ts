/**
 * The scope rule of `transact`, shared by the engine, the provider and the
 * in-memory records so they cannot disagree: every op's kind sits in ONE
 * database file, and when more than one kind is involved they all name the
 * SAME `transactFamily`. A refusal names the rule; nothing is split silently.
 */
import { TransactRefusedError } from './errors.js'
import type { RecordKindDeclaration } from './record-kind.js'

export interface TransactMember {
  readonly kind: string
  readonly declaration: Pick<RecordKindDeclaration, 'database' | 'transactFamily'>
}

/** Throws {@link TransactRefusedError} unless the kinds may share one transaction. */
export function assertTransactScope(members: readonly TransactMember[]): void {
  const byKind = new Map<string, TransactMember>()
  for (const m of members) byKind.set(m.kind, m)
  const kinds = [...byKind.values()]
  const databases = new Set(kinds.map((m) => m.declaration.database))
  if (databases.size > 1) {
    const where = kinds.map((m) => `${m.kind}@${m.declaration.database}`).join(', ')
    throw new TransactRefusedError(
      `cross-file: the ops span more than one database file (${where}); a transaction lives in ONE file`,
    )
  }
  if (kinds.length <= 1) return
  const missing = kinds.filter((m) => m.declaration.transactFamily === undefined)
  if (missing.length > 0) {
    throw new TransactRefusedError(
      `no-family: ${missing.map((m) => m.kind).join(', ')} declare no transactFamily; kinds that must agree through transact share one`,
    )
  }
  const families = new Set(kinds.map((m) => m.declaration.transactFamily))
  if (families.size > 1) {
    const where = kinds.map((m) => `${m.kind}=${String(m.declaration.transactFamily)}`).join(', ')
    throw new TransactRefusedError(
      `cross-family: the ops span more than one transactFamily (${where})`,
    )
  }
}
