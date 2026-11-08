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
