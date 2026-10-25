/**
 * The `deviceState` CLAIM methods (D663): `claimFields`, `patchOwnedFields`,
 * `releaseClaim`, `listClaims`. Thin over two authorities — the mirror owns the
 * row and the merge, the index owns the listing — and the ORDER between them:
 *
 *   claim   : index first, then the row — when the index does not yet name the
 *             (device, cap). A crash leaves an index entry with no row claim,
 *             which is harmless (a row read at the next seed) and self-heals;
 *             the reverse would let a claimed device seed without its row.
 *             When the index ALREADY names the pair (a standing owner), the
 *             row goes first and the index moves only on `ok`: `hasClaims` is
 *             already true, so index-first buys nothing, and it would name an
 *             owner the row is about to refuse.
 *   release : row first, then the index.  `not-claimed` from the row also drops
 *             the index entry — that is how an orphan heals (condition ii).
 *
 * Every method refuses by NAME (`ClaimOutcome`), never by silence: an unknown
 * device, a device whose migration is in flight (its row is about to be swapped
 * with another's — D663 5b), a value outside the planned field set (S5). A
 * failed store write REJECTS (I-4): the composer reads a rejection as unknown
 * and re-sends; a typed refusal is a fact about the claim, a rejection a fact
 * about the store.
 */
import type {
  ClaimOutcome,
  ClaimsListing,
  FieldClaim,
  FieldClaimMode,
  IScopedLogger,
} from '@camstack/types'
import type { DeviceManagerSettings } from './device-meta-store.js'
import { refused } from './device-state-claim-views.js'
import type { DeviceStateMirror } from './device-state-mirror.js'
import type { ClaimKey, FieldClaimsIndex } from './field-claims-index.js'

export interface ClaimFieldsInput {
  readonly deviceId: number
  readonly capName: string
  readonly owner: string
  readonly mode: FieldClaimMode
  readonly fields: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
}

export interface PatchOwnedFieldsInput {
  readonly deviceId: number
  readonly capName: string
  readonly owner: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface ReleaseClaimInput {
  readonly deviceId: number
  readonly capName: string
  readonly owner: string
}

export interface ListClaimsInput {
  readonly ownerPrefix?: string
}

export interface DeviceStateClaimMethods {
  claimFields(input: ClaimFieldsInput): Promise<ClaimOutcome>
  patchOwnedFields(input: PatchOwnedFieldsInput): Promise<ClaimOutcome>
  releaseClaim(input: ReleaseClaimInput): Promise<ClaimOutcome>
  listClaims(input: ListClaimsInput): Promise<ClaimsListing>
}

export interface DeviceStateClaimDeps {
  readonly mirror: Pick<DeviceStateMirror, 'claim' | 'patchOwned' | 'release'>
  readonly index: FieldClaimsIndex
  readonly settings: DeviceManagerSettings
  readonly logger: IScopedLogger
  /** Is this a device the ledger knows? `resolvePersistedById(id) !== null`. */
  deviceExists(deviceId: number): Promise<boolean>
  /** Is a migration involving this device running right now? */
  migrationInFlight(deviceId: number): boolean
}

export function createDeviceStateClaimMethods(deps: DeviceStateClaimDeps): DeviceStateClaimMethods {
  const { mirror, index, settings, logger } = deps

  function unknownDevice(deviceId: number): ClaimOutcome {
    return refused('unknown-device', `device ${deviceId} is not registered`)
  }

  /** A device under migration takes no claim, patch or release — refused by name, before either store. */
  function migrating(deviceId: number, op: string): ClaimOutcome | null {
    if (!deps.migrationInFlight(deviceId)) return null
    logger.warn(`${op} refused — a migration of the device is in flight`, {
      tags: { deviceId },
      meta: { op },
    })
    return refused(
      'migration-in-flight',
      `device ${deviceId} is being migrated — its row is about to be swapped; retry once the migration is over`,
    )
  }

  function claimOnRow(input: ClaimFieldsInput): Promise<ClaimOutcome> {
    return mirror.claim(
      input.deviceId,
      input.capName,
      {
        owner: input.owner,
        mode: input.mode,
        fields: [...input.fields],
        values: { ...input.values },
      },
      settings,
    )
  }

  return {
    async claimFields(input) {
      const { deviceId, capName, owner, mode, fields } = input
      const outside = Object.keys(input.values).filter((k) => !fields.includes(k))
      if (outside.length > 0) {
        return refused(
          'field-not-claimed',
          `values name fields outside the claim: ${outside.join(', ')}`,
        )
      }
      if (!(await deps.deviceExists(deviceId))) return unknownDevice(deviceId)
      const gated = migrating(deviceId, 'claim')
      if (gated) return gated
      const key: ClaimKey = { deviceId, capName }
      const entry: FieldClaim = { deviceId, capName, owner, mode, fields: [...fields] }
      if (index.entry(key) !== undefined) {
        // A standing owner: the row decides, the index follows only an `ok` —
        // it never names an owner the row refused (I-3).
        const outcome = await claimOnRow(input)
        if (outcome.ok) await index.upsert(entry, settings)
        return outcome
      }
      await index.upsert(entry, settings)
      let outcome: ClaimOutcome
      try {
        outcome = await claimOnRow(input)
      } catch (err: unknown) {
        // The index announces a claim the row never took: kept on purpose (a
        // superset is safe, a subset is not) and healed by the next release.
        logger.warn('claim row write failed — index entry kept; a release heals it', {
          tags: { deviceId },
          meta: { cap: capName, owner, error: errorMessage(err) },
        })
        throw err
      }
      if (!outcome.ok) await dropRefusedEntry(key, outcome.code)
      return outcome
    },

    async patchOwnedFields(input) {
      if (!(await deps.deviceExists(input.deviceId))) return unknownDevice(input.deviceId)
      const gated = migrating(input.deviceId, 'patch')
      if (gated) return gated
      return mirror.patchOwned(
        input.deviceId,
        input.capName,
        input.owner,
        { ...input.values },
        settings,
      )
    },

    async releaseClaim(input) {
      const { deviceId, capName, owner } = input
      const key: ClaimKey = { deviceId, capName }
      if (!(await deps.deviceExists(deviceId))) {
        // The device is gone; so is any claim it carried. Its entry goes too.
        await index.remove(key, settings)
        return unknownDevice(deviceId)
      }
      const gated = migrating(deviceId, 'release')
      if (gated) return gated
      const outcome = await mirror.release(deviceId, capName, owner, settings)
      // After the row: an entry is removed once the row no longer carries the
      // claim — released now, or never there (the orphan an earlier failed
      // write left behind, condition ii).
      if (outcome.ok || outcome.code === 'not-claimed') await index.remove(key, settings)
      return outcome
    },

    async listClaims(input) {
      await index.load(settings)
      return index.list(input.ownerPrefix)
    },
  }

  /** A first claim the row refused must not stay announced: drop the entry this call added. */
  async function dropRefusedEntry(key: ClaimKey, code: string): Promise<void> {
    try {
      await index.remove(key, settings)
    } catch (err: unknown) {
      logger.warn(
        'claims index not restored after a refused claim — stale entry until the next release',
        {
          tags: { deviceId: key.deviceId },
          meta: { cap: key.capName, refusal: code, error: errorMessage(err) },
        },
      )
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
