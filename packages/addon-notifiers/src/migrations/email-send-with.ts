/**
 * An email target names the instance that sends its mail with ONE link, `sendWith` (a Google account
 * or an SMTP relay). A target written before named a provider addon (`smtpAddonId`) and, optionally,
 * one relay of it (`smtpInstanceId`). This step fills the link from those keys and drops them; every
 * other field of the row (recipients, switch, owner) is carried as stored.
 *
 * A row that named only its provider is linked to the sender the OLD send path would have used: the
 * one whose address matches the row's `from`, else the provider's first usable one — never one that
 * is signed out. A row whose provider holds no usable sender is left as it was (it still sends through
 * the provider it pinned) and is named in the summary. A provider that cannot be read, or is not
 * registered yet (it boots after this addon), fails the step, so the next boot runs it again (D49: an
 * unanswered read never decides).
 */
import {
  type IntegrationInstance,
  type InstanceSource,
  instancesOfCap,
  type MigrationProcedureResult,
} from '@camstack/types'
import {
  EMAIL_SENDER_KEY,
  LEGACY_SMTP_ADDON_KEY,
  LEGACY_SMTP_INSTANCE_KEY,
} from '../adapters/email.js'

export const EMAIL_SEND_WITH_ID = 'notifiers/2026-11-13-email-send-with'

/** One stored email target row: its id, its revision and its flat body. */
export interface EmailTargetRow {
  readonly id: string
  readonly rev: number
  readonly data: Readonly<Record<string, unknown>>
}

/** One sender a provider holds, as the legacy pick saw it. */
export interface LegacySenderCandidate {
  readonly id: string
  /** Switched on and, when it reports a session, signed in. */
  readonly usable: boolean
  /** The addresses it sends as (an account's own, its From); lower-case match. */
  readonly addresses: readonly string[]
}

export interface EmailSendWithPorts {
  /** Every stored email target row. */
  readonly list: () => Promise<readonly EmailTargetRow[]>
  /** Replace a row's body, refused when the row moved past `rev`. */
  readonly replace: (row: EmailTargetRow) => Promise<void>
  /**
   * The senders provider `addonId` holds for `smtp-provider`, in its order. Rejects when the provider
   * could not be read or is not registered (yet).
   */
  readonly sendersOf: (addonId: string) => Promise<readonly LegacySenderCandidate[]>
}

/** The form values a sender states its addresses in: an account's own, and the From it sends as. */
const SENDER_ADDRESS_KEYS = ['accountEmail', 'fromAddress'] as const

/**
 * A provider's sender as the legacy pick sees it: usable when switched on and, if it reports a
 * session, signed in (a signed-out account is never pinned).
 */
export function legacySenderCandidate(instance: IntegrationInstance): LegacySenderCandidate {
  const addresses = SENDER_ADDRESS_KEYS.flatMap((key) => {
    const value = instance.formValues[key]
    return typeof value === 'string' && value.trim() !== '' ? [value] : []
  })
  const signedIn = instance.status === undefined || instance.status.state === 'ok'
  return { id: instance.id, usable: instance.enabled !== false && signedIn, addresses }
}

/**
 * `sendersOf` over the instance source: the senders provider `addonId` holds for `cap`. A provider
 * that is not registered yet (it boots after this addon) or does not answer REJECTS — neither is an
 * answer, and the step is retried on the next boot.
 */
export function legacySendersOver(
  source: InstanceSource,
  cap: string,
): (addonId: string) => Promise<readonly LegacySenderCandidate[]> {
  return async (addonId) => {
    if (!(await source.holders(cap)).includes(addonId))
      throw new Error(`the mail provider ${addonId} is not registered yet`)
    const listed = await instancesOfCap(source, cap)
    const failed = listed.unreadable.find((entry) => entry.addonId === addonId)
    if (failed !== undefined) throw new Error(`${addonId} could not be read: ${failed.error}`)
    return listed.instances
      .filter((entry) => entry.addonId === addonId)
      .map((entry) => legacySenderCandidate(entry.instance))
  }
}

/** The bare address of a From header (`Ops <ops@x>` → `ops@x`), lower-case. */
function bareAddress(from: string): string {
  const angle = /<([^>]+)>/.exec(from)
  return (angle?.[1] ?? from).trim().toLowerCase()
}

/**
 * The sender the old path picked for a target that named only its provider: among the usable ones,
 * the one whose address is the target's From, else the first. Null when none is usable.
 */
export function pickLegacySender(
  candidates: readonly LegacySenderCandidate[],
  from: string | undefined,
): string | null {
  const usable = candidates.filter((candidate) => candidate.usable)
  if (from !== undefined) {
    const want = bareAddress(from)
    const match = usable.find((candidate) =>
      candidate.addresses.some((address) => address.trim().toLowerCase() === want),
    )
    if (match !== undefined) return match.id
  }
  return usable[0]?.id ?? null
}

function text(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const raw = data[key]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/** `data` without the two keys the link replaces. */
function withoutLegacyKeys(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key !== LEGACY_SMTP_ADDON_KEY && key !== LEGACY_SMTP_INSTANCE_KEY) out[key] = value
  }
  return out
}

/** The sender a legacy row pinned: its relay when it named one, else the one the old path picked. */
async function legacySenderOf(
  data: Readonly<Record<string, unknown>>,
  ports: EmailSendWithPorts,
): Promise<string | null> {
  const relay = text(data, LEGACY_SMTP_INSTANCE_KEY)
  if (relay !== undefined) return relay
  const provider = text(data, LEGACY_SMTP_ADDON_KEY)
  if (provider === undefined) return null
  return pickLegacySender(await ports.sendersOf(provider), text(data, 'from'))
}

export async function linkEmailSenders(
  ports: EmailSendWithPorts,
): Promise<MigrationProcedureResult> {
  let converted = 0
  const unresolved: string[] = []
  for (const row of await ports.list()) {
    const hasLegacy =
      row.data[LEGACY_SMTP_ADDON_KEY] !== undefined ||
      row.data[LEGACY_SMTP_INSTANCE_KEY] !== undefined
    const linked = text(row.data, EMAIL_SENDER_KEY)
    if (linked !== undefined) {
      if (!hasLegacy) continue
      await ports.replace({ ...row, data: withoutLegacyKeys(row.data) })
      converted++
      continue
    }
    if (!hasLegacy) continue
    const sender = await legacySenderOf(row.data, ports)
    if (sender === null) {
      unresolved.push(row.id)
      continue
    }
    await ports.replace({
      ...row,
      data: { ...withoutLegacyKeys(row.data), [EMAIL_SENDER_KEY]: sender },
    })
    converted++
  }
  return {
    outcome: converted > 0 ? 'done' : 'already-done',
    summary: { converted, unresolved },
  }
}
