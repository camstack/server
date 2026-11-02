/**
 * The camera-mail intake moves from this addon's own SMTP server to a mailbox of the
 * `smtp-inbound` broker (D999). The cameras already know the port, the domain, the username and
 * the password, so the mailbox is created carrying exactly those: no camera is reconfigured.
 *
 * Idempotent: an existing mailbox is `already-done`, never replaced. Nothing is created from a
 * password that cannot be read (a locked keychain would otherwise mint a new one and break every
 * camera): `readStored` throws, the run fails, and the next boot retries. The legacy keys stay one
 * release, so a restore of an older snapshot still finds them.
 */
import type { MigrationProcedureResult } from '@camstack/types'

/** What the broker is asked to create: the settings of `SmtpInboundSettingsSchema` the cameras know. */
export interface LegacyMailboxSettings {
  readonly port: number
  readonly domain: string
  readonly requireAuth: boolean
  readonly username: string
  readonly password: string
}

export interface EmailPushMigrationPorts {
  /** The stored settings, the password resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Create the default mailbox with these settings; `exists` when it is already there. */
  addMailbox(settings: LegacyMailboxSettings): Promise<'created' | 'exists'>
  warn(message: string): void
}

/** The keys an install that ever used the intake has; any one of them means "carry it over". */
const LEGACY_KEYS = [
  'emailPushPort',
  'emailPushDomain',
  'emailPushRequireAuth',
  'emailPushAuthUsername',
  'emailPushAuthPassword',
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
  const placed = await ports.addMailbox({
    port: portOf(stored, ports),
    domain: text(stored, 'emailPushDomain') ?? DEFAULT_DOMAIN,
    requireAuth: stored['emailPushRequireAuth'] !== false,
    username: text(stored, 'emailPushAuthUsername') ?? '',
    password: text(stored, 'emailPushAuthPassword') ?? '',
  })
  return placed === 'created'
    ? { outcome: 'done', summary: { moved: true } }
    : { outcome: 'already-done', summary: { moved: false } }
}
