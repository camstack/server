/**
 * The camera-mail intake moves from this addon's own SMTP server to a mailbox of the
 * `smtp-inbound` broker (D999). The cameras already know the port, the domain, the username and
 * the password, so the mailbox must be created carrying exactly those: no camera is reconfigured.
 *
 * This migration is PURE LOCAL. The mail addon may not be installed, or may register after this
 * addon, so nothing here calls it: the legacy settings (the password resolved through the
 * keychain) are copied into a pending-mailbox state, and the bridge creates the mailbox with
 * them the first time the broker is reachable. A password that cannot be read (a locked keychain)
 * fails the run and writes nothing, so a credential is never minted in its place; the migration
 * is `tolerate`, so the addon and its cameras keep running while the next boot retries. The
 * legacy keys stay one release, so a restore of an older snapshot still finds them.
 */
import type { MigrationProcedureResult } from '@camstack/types'
import { z } from 'zod'

/** What the mailbox is created with: the settings of `SmtpInboundSettingsSchema` the cameras know. */
export interface LegacyMailboxSettings {
  readonly port: number
  readonly bindHost?: string
  readonly domain: string
  readonly requireAuth: boolean
  readonly username: string
  readonly password: string
}

/** The pending mailbox as kept in the addon store: everything but the password (a keychain secret). */
export const PendingMailboxSchema = z.object({
  port: z.number().int(),
  bindHost: z.string().optional(),
  domain: z.string(),
  requireAuth: z.boolean(),
  username: z.string(),
})
export type PendingMailbox = z.infer<typeof PendingMailboxSchema>

export interface EmailPushMigrationPorts {
  /** The stored settings, the password resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** The stored settings as written, no secret resolved: for a migration that moves no credential. */
  readStoredRaw(): Promise<Readonly<Record<string, unknown>>>
  /** Keep these settings until the mailbox provider can create the mailbox. Local only. */
  stashPending(settings: LegacyMailboxSettings): Promise<void>
  warn(message: string): void
}

/** The keys an install that ever used the intake has; any one of them means "carry it over". */
const LEGACY_KEYS = [
  'emailPushPort',
  'emailPushDomain',
  'emailPushRequireAuth',
  'emailPushAuthUsername',
  'emailPushAuthPassword',
  'emailPushBindHost',
] as const

const DEFAULT_PORT = 2525
const DEFAULT_DOMAIN = 'camstack.local'

function text(stored: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = stored[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function portOf(stored: Readonly<Record<string, unknown>>, ports: EmailPushMigrationPorts): number {
  const value = stored['emailPushPort']
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535) return numeric
  if (value !== undefined) {
    ports.warn(`email-push migration: the legacy port is not usable; using ${DEFAULT_PORT}`)
  }
  return DEFAULT_PORT
}

export async function moveEmailPushToMailbox(
  ports: EmailPushMigrationPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  if (!LEGACY_KEYS.some((key) => stored[key] !== undefined)) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  if (stored['emailPushEnabled'] === false) {
    // The operator had the intake off: no camera mails here, so nothing is carried and nothing is
    // created until a camera needs it.
    return {
      outcome: 'already-done',
      summary: { moved: false, disabled: true },
    }
  }
  const bindHost = text(stored, 'emailPushBindHost')
  await ports.stashPending({
    port: portOf(stored, ports),
    ...(bindHost === null ? {} : { bindHost }),
    domain: text(stored, 'emailPushDomain') ?? DEFAULT_DOMAIN,
    requireAuth: stored['emailPushRequireAuth'] !== false,
    username: text(stored, 'emailPushAuthUsername') ?? '',
    password: text(stored, 'emailPushAuthPassword') ?? '',
  })
  return { outcome: 'done', summary: { moved: true } }
}
