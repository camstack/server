/**
 * The two reads the composer takes ONCE before its first decision (D49): the
 * composed rows it already owns (before any withdrawal) and the claims the hub
 * holds (before any release). Each is a `ConfirmedSeed`: an unread or a
 * first-empty answer waits, by name, for an agreeing read.
 */
import { errMsg, type FieldClaim, type IScopedLogger } from '@camstack/types'
import type { PersistedComposedRow } from './composition-declarations.js'
import { ConfirmedSeed, type SeedRead } from './confirmed-seed.js'
import type { ComposerClaimsApi } from './existing-target.js'

const ROWS_UNREAD =
  "the composer's own device rows could not be read — nothing is declared or withdrawn until they are"
const ROWS_EMPTY_UNCONFIRMED =
  "the composer's own device rows read empty once — a cold registry answers the same, so nothing is declared or withdrawn until the next apply's read agrees"
const CLAIMS_NOT_LOADED =
  'the claims index has not loaded — nothing is claimed or released until it does'
const CLAIMS_EMPTY_UNCONFIRMED =
  "the claims index read empty once — nothing is claimed or released until the next apply's read agrees"

export interface ComposedRowSeedDeps {
  readonly logger: IScopedLogger
  /** The composed rows that already exist (`listOwnDevices`). */
  readonly readPersisted: () => Promise<readonly PersistedComposedRow[]>
  readonly onSeeded: (rows: readonly PersistedComposedRow[]) => void
}

/** The rows the composer owns, read ONCE before its first withdrawal decision. */
export function composedRowSeed(deps: ComposedRowSeedDeps): ConfirmedSeed<PersistedComposedRow> {
  return new ConfirmedSeed({
    logger: deps.logger,
    subject: "composer's own device rows",
    read: async (): Promise<SeedRead<PersistedComposedRow>> => {
      try {
        return { kind: 'items', items: await deps.readPersisted() }
      } catch (err: unknown) {
        return { kind: 'unknown', error: errMsg(err) }
      }
    },
    onSeeded: deps.onSeeded,
    unreadReason: ROWS_UNREAD,
    emptyUnconfirmedReason: ROWS_EMPTY_UNCONFIRMED,
  })
}

export interface ClaimIndexSeedDeps {
  readonly logger: IScopedLogger
  readonly claims: ComposerClaimsApi
  readonly onSeeded: (claims: readonly FieldClaim[]) => void
}

/**
 * The claims the hub holds, read ONCE before the first release decision (rule
 * 3). `not-loaded` is UNKNOWN (D315), never empty.
 */
export function claimIndexSeed(deps: ClaimIndexSeedDeps): ConfirmedSeed<FieldClaim> {
  return new ConfirmedSeed({
    logger: deps.logger,
    subject: 'claims index',
    read: async (): Promise<SeedRead<FieldClaim>> => {
      try {
        const listing = await deps.claims.listClaims({ ownerPrefix: '' })
        return listing.state === 'loaded'
          ? { kind: 'items', items: listing.claims }
          : { kind: 'unknown', error: listing.reason }
      } catch (err: unknown) {
        return { kind: 'unknown', error: errMsg(err) }
      }
    },
    onSeeded: deps.onSeeded,
    unreadReason: CLAIMS_NOT_LOADED,
    emptyUnconfirmedReason: CLAIMS_EMPTY_UNCONFIRMED,
  })
}
