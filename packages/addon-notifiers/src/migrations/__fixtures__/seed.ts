/**
 * The legacy data the `notifiers` catalogue meets on a node that last ran a release which kept every
 * notification target as one record with a free-form `config` blob: written by hand, in the shape
 * that release stored it. The Telegram row carries a MARK in its token and is switched off, the
 * fields a migration that re-built a row would drop or reset. The migration spec seeds from here.
 */
export const LEGACY_TARGET_TOKEN = 'tg-token-MARK-8f31'

export interface LegacyTargetData {
  name: string
  kind: string
  addonId: string
  enabled: boolean
  config: Record<string, unknown>
}

export interface LegacyTargetRow {
  readonly id: string
  readonly data: LegacyTargetData
}

/** A switched-off Telegram target a notification rule names by its id. */
export const LEGACY_TELEGRAM_TARGET: LegacyTargetRow = {
  id: 'tg-1',
  data: {
    name: 'Phone',
    kind: 'telegram',
    addonId: 'notifiers',
    enabled: false,
    config: { botToken: LEGACY_TARGET_TOKEN, chatId: '42' },
  },
}

/** A row of a kind this addon does not serve: it must stay where it is. */
export const LEGACY_FOREIGN_TARGET: LegacyTargetRow = {
  id: 'x-1',
  data: {
    name: 'Other',
    kind: 'unknown-kind',
    addonId: 'notifiers',
    enabled: true,
    config: {},
  },
}

/**
 * Email target bodies as the release before `sendWith` stored them, already in the per-kind record
 * (`notify-email`): flat, the provider named by `smtpAddonId` and one relay by `smtpInstanceId`. The
 * recipients and the owner carry a MARK and the target is switched off — the fields a step that
 * re-built the row would drop or reset.
 */
export const LEGACY_EMAIL_RECIPIENT = 'ops-MARK-77c2@example.com'
export const LEGACY_EMAIL_OWNER = 'user-MARK-9e04'

export interface LegacyEmailRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

/** Pinned to one relay of the SMTP provider. */
export const LEGACY_EMAIL_RELAY_TARGET: LegacyEmailRow = {
  id: 'mail-relay',
  data: {
    name: 'Night shift',
    enabled: false,
    to: LEGACY_EMAIL_RECIPIENT,
    ownerUserId: LEGACY_EMAIL_OWNER,
    smtpAddonId: 'smtp-nodemailer',
    smtpInstanceId: 'relay-7',
  },
}

/** Naming only the provider (its default sender). */
export const LEGACY_EMAIL_PROVIDER_TARGET: LegacyEmailRow = {
  id: 'mail-google',
  data: {
    name: 'Family',
    enabled: true,
    to: 'family@example.com',
    smtpAddonId: 'google-services',
  },
}
