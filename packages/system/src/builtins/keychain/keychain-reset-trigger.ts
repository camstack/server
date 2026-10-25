/**
 * The one-shot `RESET_KEYCHAIN` trigger file — the way back into a hub whose
 * master key is lost (operator decision 2026-10-09; plan §2).
 *
 * ## Why a file
 *
 * A locked keychain cannot be reset from System → Secrets: the session signing
 * key lives IN the keychain (D797), so no login and no bearer token verifies,
 * and every admin credential is a signing-key JWT. Whoever can write the data
 * directory can already read the default master key, so a file there is the
 * same trust boundary as the key itself — and it needs nothing but host access
 * (works in a stopped container's volume, no extra binary). The pattern is
 * `RESET_ADMIN_PASSWORD`'s (`local-auth/admin-account-boot.ts`).
 *
 * ## Behaviour
 *
 * Checked once at keychain boot, right after the unlock:
 *
 *  - absent → nothing;
 *  - the keychain is UNLOCKED → ignored and deleted, with a warning. A working
 *    store is never destroyed by a file someone forgot;
 *  - locked for a key reason (`wrong-key`, `key-missing`, `key-file-unreadable`)
 *    → `KeychainService.resetAs('trigger-file')`: values and wrapped keys
 *    archived, a new master key and data key, the system-held markers cleared,
 *    the file deleted, and an error-level banner naming what to re-enter;
 *  - a reset that cannot end unlocked (a configured key file that is missing)
 *    is refused BEFORE anything is archived; the file is still deleted (one
 *    shot — fix the key source and create it again);
 *  - locked because the STORE cannot be read → left armed: nothing could be
 *    reset, and the next boot that reaches the store decides.
 *
 * NO environment variable arms it. A flag left in a container template would
 * re-arm on every boot; a file the hub deletes cannot.
 */
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import {
  KEYCHAIN_RESET_TRIGGER_ACTOR,
  type KeychainResetRecord,
  type KeychainUnavailableReason,
} from '@camstack/types'
import type { KeychainLogger, KeychainService } from './keychain-service.js'

/** The trigger's name, inside `<dataDir>/.keychain/`. */
export const KEYCHAIN_RESET_TRIGGER = 'RESET_KEYCHAIN'

/** Lock reasons a reset can cure — the master key, not the store. */
const RESETTABLE_REASONS: ReadonlySet<KeychainUnavailableReason> =
  new Set<KeychainUnavailableReason>(['wrong-key', 'key-missing', 'key-file-unreadable'])

export function keychainResetTriggerPath(dataDir: string): string {
  return path.join(dataDir, '.keychain', KEYCHAIN_RESET_TRIGGER)
}

export type KeychainResetTriggerOutcome =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ignored-unlocked' }
  | { readonly kind: 'deferred'; readonly reason: string }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'reset'; readonly record: KeychainResetRecord }

export interface KeychainResetTriggerInput {
  readonly service: Pick<KeychainService, 'getState' | 'resetAs' | 'resetReport'>
  readonly dataDir: string
  readonly logger: KeychainLogger
}

async function triggerExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function consume(file: string, logger: KeychainLogger): Promise<void> {
  try {
    await fsp.rm(file, { force: true })
  } catch (err: unknown) {
    logger.error(
      'Could not delete the RESET_KEYCHAIN trigger — delete it by hand, or the next boot with a locked keychain resets it again',
      { trigger: file, error: err instanceof Error ? err.message : String(err) },
    )
  }
}

export async function applyKeychainResetTrigger(
  input: KeychainResetTriggerInput,
): Promise<KeychainResetTriggerOutcome> {
  const { service, logger } = input
  const file = keychainResetTriggerPath(input.dataDir)
  if (!(await triggerExists(file))) return { kind: 'absent' }

  const state = service.getState()
  if (state.state === 'ready') {
    logger.warn(
      'RESET_KEYCHAIN ignored: the keychain is unlocked, so nothing is lost and nothing is reset. The trigger file was deleted.',
      { trigger: file },
    )
    await consume(file, logger)
    return { kind: 'ignored-unlocked' }
  }
  if (!RESETTABLE_REASONS.has(state.reason)) {
    logger.error(
      'RESET_KEYCHAIN not acted on yet: the keychain is locked because its store cannot be read, not because of the master key. The trigger stays until a boot can reach the store.',
      { trigger: file, reason: state.reason },
    )
    return { kind: 'deferred', reason: state.reason }
  }

  let record: KeychainResetRecord
  try {
    record = await service.resetAs(KEYCHAIN_RESET_TRIGGER_ACTOR)
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error(
      `RESET_KEYCHAIN refused — nothing was archived, the keychain is still locked: ${error}. The trigger file was deleted; fix the key source and create it again.`,
      { trigger: file, reason: state.reason },
    )
    await consume(file, logger)
    return { kind: 'refused', error }
  }
  await consume(file, logger)

  const report = await service.resetReport().catch(() => null)
  const toReenter = (report?.pendingReentry ?? []).map(
    (m) => `${m.owner}:${m.scope}:${m.fieldPath}`,
  )
  logger.error(
    '*** KEYCHAIN RESET by the RESET_KEYCHAIN trigger file *** Every stored secret was archived ' +
      '(unreadable without the lost master key) and a new master key and data key were created. ' +
      'Every secret field now reads "not set" — re-enter them (System → Secrets lists them). ' +
      'The session signing key is regenerated: everyone signs in again.',
    {
      lockedReason: state.reason,
      archived: record.archived,
      archivedCollection: record.archivedCollection,
      archivedKeysCollection: record.archivedKeysCollection,
      clearedSettingsKeys: record.clearedSettingsKeys,
      toReenter,
    },
  )
  return { kind: 'reset', record }
}
