/**
 * An email target names the instance that sends its mail with ONE link, `sendWith` (a Google account
 * or an SMTP relay). A target written before named a provider addon (`smtpAddonId`) and, optionally,
 * one relay of it (`smtpInstanceId`). This step fills the link from those keys and drops them; every
 * other field of the row (recipients, switch, owner) is carried as stored.
 *
 * A row whose provider holds no sender yet is left as it was — it still sends through the provider it
 * pinned — and is named in the summary. A provider that cannot be read fails the step, so the next
 * boot runs it again (D49: an unanswered read never decides).
 */
import type { MigrationProcedureResult } from '@camstack/types'
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

export interface EmailSendWithPorts {
  /** Every stored email target row. */
  readonly list: () => Promise<readonly EmailTargetRow[]>
  /** Replace a row's body, refused when the row moved past `rev`. */
  readonly replace: (row: EmailTargetRow) => Promise<void>
  /**
   * The first instance of provider `addonId` that serves `smtp-provider`; null when it holds none.
   * Rejects when the provider could not be read.
   */
  readonly firstSenderOf: (addonId: string) => Promise<string | null>
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

/** The sender a legacy row pinned: its relay when it named one, else the provider's first sender. */
async function legacySenderOf(
  data: Readonly<Record<string, unknown>>,
  ports: EmailSendWithPorts,
): Promise<string | null> {
  const relay = text(data, LEGACY_SMTP_INSTANCE_KEY)
  if (relay !== undefined) return relay
  const provider = text(data, LEGACY_SMTP_ADDON_KEY)
  return provider === undefined ? null : ports.firstSenderOf(provider)
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
