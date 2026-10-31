/**
 * The hold a restore of a pre-migration snapshot leaves behind (D987).
 *
 * The restored database has the ledger of BEFORE the migrations ran, so they
 * look pending and would simply run again — the bad one first. The operator
 * asked for the opposite: no rerun until a retry or a new code version. That
 * decision cannot live inside the database being replaced, so it sits beside
 * it, in `<db>.migration-hold.json`, written by the owner and read by the owner.
 *
 * Reading is three-way, never "absent on error" (D49): a file that exists and
 * cannot be read holds EVERYTHING pending, and says so.
 */
import { promises as fsp } from 'node:fs'
import { errMsg } from '@camstack/types'

export const MIGRATION_HOLD_SUFFIX = '.migration-hold.json'

export interface MigrationHold {
  /** The code version the hold was written for; another version ignores it. */
  readonly codeVersion: string
  readonly ids: readonly string[]
  readonly snapshotId: string
}

export type HoldRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly hold: MigrationHold }
  | { readonly kind: 'unreadable'; readonly error: string }

export function holdPathOf(livePath: string): string {
  return livePath + MIGRATION_HOLD_SUFFIX
}

function isHold(value: unknown): value is MigrationHold {
  return (
    typeof value === 'object' &&
    value !== null &&
    'codeVersion' in value &&
    typeof value.codeVersion === 'string' &&
    'snapshotId' in value &&
    typeof value.snapshotId === 'string' &&
    'ids' in value &&
    Array.isArray(value.ids) &&
    value.ids.every((id: unknown) => typeof id === 'string')
  )
}

export async function readHold(livePath: string): Promise<HoldRead> {
  let text: string
  try {
    text = await fsp.readFile(holdPathOf(livePath), 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', error: errMsg(err) }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isHold(parsed)
      ? { kind: 'present', hold: parsed }
      : { kind: 'unreadable', error: 'not a migration hold' }
  } catch (err) {
    return { kind: 'unreadable', error: errMsg(err) }
  }
}

/** Atomic: a temp file, then a rename — a hold half written is the unreadable case above. */
export async function writeHold(livePath: string, hold: MigrationHold): Promise<void> {
  const file = holdPathOf(livePath)
  const temp = `${file}.tmp`
  await fsp.writeFile(temp, JSON.stringify(hold), { mode: 0o600 })
  await fsp.rename(temp, file)
}

export async function clearHold(livePath: string): Promise<void> {
  await fsp.rm(holdPathOf(livePath), { force: true })
}

/** Drop `ids` from the hold; an emptied hold is removed. */
export async function releaseFromHold(livePath: string, ids: readonly string[]): Promise<void> {
  const read = await readHold(livePath)
  if (read.kind !== 'present') return
  const left = read.hold.ids.filter((id) => !ids.includes(id))
  if (left.length === 0) await clearHold(livePath)
  else await writeHold(livePath, { ...read.hold, ids: left })
}
