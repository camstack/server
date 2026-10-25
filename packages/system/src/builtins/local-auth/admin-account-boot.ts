/**
 * The admin account at boot: seed it once, reset it only on the operator's
 * explicit one-shot request, and say so when it still has the default password.
 *
 * ## Why a trigger FILE, not a variable
 *
 * A fresh hub seeds `admin` / `changeme` on its first boot (D797) and never
 * applies it again — a password the operator changes in the admin UI survives
 * every restart. Recovering a forgotten
 * password therefore needs an explicit request, and that request must be
 * ONE-SHOT: an environment flag stays set in a container template until someone
 * remembers to remove it, and while it is set it reverts the password on every
 * boot — the very defect this replaced. A file the hub DELETES after acting on
 * it cannot be left armed: create `RESET_ADMIN_PASSWORD` in the node's data
 * directory (`/data` in the container), restart, and the `admin` user's
 * password is set back to `changeme`, once — the next sign-in forces a change.
 */
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import {
  type AdminSeedOutcome,
  type EnsureAdminOptions,
  // Compared by HASH at boot, to warn while the admin still signs in with it.
  FIRST_BOOT_ADMIN_PASSWORD,
} from '../../auth/user-manager.js'

/** The trigger's name, at the root of the node's data directory. */
export const ADMIN_PASSWORD_RESET_TRIGGER = 'RESET_ADMIN_PASSWORD'

/** The file operations the boot step needs — injectable for tests. */
export interface TriggerFs {
  exists(filePath: string): boolean
  remove(filePath: string): void
}

/** The slice of `UserManager` the boot step drives. */
export interface AdminAccountManager {
  ensureAdminExists(options?: EnsureAdminOptions): Promise<AdminSeedOutcome>
  hasPassword(username: string, password: string): Promise<boolean>
}

export interface AdminAccountBootInput {
  readonly users: AdminAccountManager
  /** `ctx.nodeDataDir` — where the operator drops the trigger. */
  readonly dataDir: string
  readonly fs: TriggerFs
  readonly logger: IScopedLogger
}

export interface AdminAccountBootResult {
  readonly outcome: AdminSeedOutcome
  /** The admin still signs in with {@link FIRST_BOOT_ADMIN_PASSWORD}. */
  readonly usesDefaultPassword: boolean
}

export async function reconcileAdminAccountAtBoot(
  input: AdminAccountBootInput,
): Promise<AdminAccountBootResult> {
  const { users, fs, logger } = input
  const triggerPath = path.join(input.dataDir, ADMIN_PASSWORD_RESET_TRIGGER)
  const resetRequested = fs.exists(triggerPath)
  const outcome = await users.ensureAdminExists({ resetPassword: resetRequested })
  logOutcome(outcome, logger)
  if (resetRequested) consumeTrigger(triggerPath, outcome, input)

  const username = 'username' in outcome ? outcome.username : null
  const usesDefaultPassword =
    username !== null && (await users.hasPassword(username, FIRST_BOOT_ADMIN_PASSWORD))
  if (usesDefaultPassword && username !== null) {
    logger.warn(
      'The admin account still uses the default password — change it in the admin UI ' +
        '(the first sign-in with it asks for a new one)',
      { meta: { username } },
    )
  }
  return { outcome, usesDefaultPassword }
}

function logOutcome(outcome: AdminSeedOutcome, logger: IScopedLogger): void {
  switch (outcome.kind) {
    case 'seeded':
      logger.info(
        'Admin account seeded (first boot) — sign in as admin / changeme and set a password',
        {
          meta: { username: outcome.username },
        },
      )
      return
    case 'reset':
      logger.warn('Admin password reset to the first-boot password, as requested', {
        meta: { username: outcome.username },
      })
      return
    case 'other-admin-exists':
      logger.info('First-boot admin not seeded: another admin account already exists', {
        meta: { username: outcome.username },
      })
      return
    case 'exists':
      return
  }
}

/** Delete the trigger after acting on it — a reset must never repeat by itself. */
function consumeTrigger(
  triggerPath: string,
  outcome: AdminSeedOutcome,
  input: AdminAccountBootInput,
): void {
  if (outcome.kind !== 'reset') {
    input.logger.warn('Admin password reset requested, but there is no `admin` user to reset', {
      meta: { trigger: triggerPath, outcome: outcome.kind },
    })
  }
  try {
    input.fs.remove(triggerPath)
  } catch (err: unknown) {
    input.logger.error(
      'Could not delete the admin password reset trigger — delete it by hand, or every ' +
        'restart resets the admin password again',
      { meta: { trigger: triggerPath, error: err instanceof Error ? err.message : String(err) } },
    )
  }
}
