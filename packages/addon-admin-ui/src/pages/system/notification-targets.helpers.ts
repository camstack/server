/**
 * Pure helpers for the notification targets management page (T14).
 *
 * Kept out of the React component so the catalog grouping and the
 * secret-merge diff can be unit-tested without a DOM. All functions are
 * side-effect free and return new objects (no mutation).
 */
import type { ConfigField, ConfigUISchema, TargetKind } from '@camstack/types'
import i18n from '../../i18n/index'

/** One addon's slice of the kind catalog, in first-seen order. */
export interface KindGroup<K extends TargetKind = TargetKind> {
  readonly addonId: string
  readonly kinds: readonly K[]
}

/**
 * Group the concat-fanned `listTargetKinds` catalog by the `addonId` each
 * provider stamps, preserving first-appearance order for both groups and
 * the kinds within them (stable, deterministic UI).
 *
 * Generic over the kind element so a caller passing an icon-augmented kind
 * (`TargetKind & { iconUrl? }`) keeps that field on the grouped result.
 */
export function groupKindsByAddon<K extends TargetKind>(kinds: readonly K[]): KindGroup<K>[] {
  const order: string[] = []
  const byAddon = new Map<string, K[]>()
  for (const kind of kinds) {
    const existing = byAddon.get(kind.addonId)
    if (existing) {
      existing.push(kind)
    } else {
      byAddon.set(kind.addonId, [kind])
      order.push(kind.addonId)
    }
  }
  return order.map((addonId) => ({ addonId, kinds: byAddon.get(addonId) ?? [] }))
}

/**
 * Collect the keys of every `type:'password'` field in a kind's
 * `configSchema`, recursing into `group` / `sub-tabs` containers. These are
 * the secret fields the UI masks and only sends when the operator re-types
 * them.
 */
export function collectSecretKeys(schema: ConfigUISchema): string[] {
  const keys: string[] = []
  const walk = (fields: readonly ConfigField[]): void => {
    for (const field of fields) {
      if (field.type === 'password') {
        keys.push(field.key)
        continue
      }
      if (field.type === 'group') {
        walk(field.fields)
        continue
      }
      if (field.type === 'sub-tabs') {
        for (const tab of field.tabs) walk(tab.fields)
      }
    }
  }
  for (const section of schema.sections) walk(section.fields)
  return keys
}

/** Every field's label by key, containers walked — what the form calls each. */
export function collectFieldLabels(schema: ConfigUISchema): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  const walk = (fields: readonly ConfigField[]): void => {
    for (const field of fields) {
      if (field.type === 'group') walk(field.fields)
      else if (field.type === 'sub-tabs') for (const tab of field.tabs) walk(tab.fields)
      else if (field.type !== 'separator') labels.set(field.key, field.label)
    }
  }
  for (const section of schema.sections) walk(section.fields)
  return labels
}

/** Presence marker `listTargets` returns for a stored secret (notifiers). */
export const SECRET_PRESENT_MARKER = '__redacted__'

/**
 * Value seeded into a password input from a REDACTED list row until
 * `getTarget` replaces it with the live secret. `secretMergeDiff` omits it
 * so the hub can restore from store when hydration failed / is unavailable.
 */
export const SECRET_UI_MASK = '••••••••'

/** True when the form still holds a non-secret stand-in, not a typed token. */
export function isSecretStandIn(value: unknown): boolean {
  return value === SECRET_UI_MASK || value === SECRET_PRESENT_MARKER
}

/**
 * Produce the `config` object to persist via `upsertTarget`.
 *
 * Non-secret fields flow through verbatim. Secrets are included when the form
 * holds a real value (from `getTarget` hydration or a re-type) — including when
 * unchanged — so Duplicate / an edit that moves `chatId` still carries the
 * token and does not trip D634 restore. Empty / UI-mask / `__redacted__`
 * stand-ins are omitted so the hub can restore from store when appropriate.
 */
export function secretMergeDiff(
  form: Record<string, unknown>,
  _original: Record<string, unknown>,
  secretKeys: readonly string[],
): Record<string, unknown> {
  const secretSet = new Set(secretKeys)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(form)) {
    if (!secretSet.has(key)) {
      out[key] = value
      continue
    }
    const isEmpty = value === undefined || value === null || value === ''
    if (isEmpty || isSecretStandIn(value)) continue
    out[key] = value
  }
  return out
}

/**
 * Seed the edit form from a REDACTED list row (secrets → UI mask) until
 * `getTarget` hydrates the live token via {@link liveFormValues}.
 */
export function redactedFormValues(
  config: Record<string, unknown>,
  secretKeys: readonly string[],
): Record<string, unknown> {
  const secretSet = new Set(secretKeys)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!secretSet.has(key)) {
      out[key] = value
      continue
    }
    const present = value !== undefined && value !== null && value !== ''
    out[key] = present ? SECRET_UI_MASK : ''
  }
  return out
}

/** Seed the edit/duplicate form from an unredacted `getTarget` row. */
export function liveFormValues(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config }
}

// ── ADR 0634: a stored secret only goes where it was typed for ─────────

/**
 * The hub's refusal to reuse a redacted secret after a destination edit
 * (`SecretRestoreRefusedError` in addon-notifiers). Matched on the sentence
 * the hub guarantees, anywhere in the message — a transport may prefix it.
 */
const SECRET_REFUSAL_MARKERS: readonly string[] = [
  'Refusing to reuse the stored secret',
  'Re-enter the secret',
]

export function isSecretRestoreRefusal(message: string): boolean {
  return SECRET_REFUSAL_MARKERS.some((marker) => message.includes(marker))
}

/** Absent, null and '' are the same "nothing" — as the hub compares them. */
function comparable(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * The NON-secret keys whose value the operator changed. The admin does not
 * know which of them are a kind's destination (the hub does), so any of them
 * may be — the form treats a change as "the hub may ask for the secret".
 */
export function editedNonSecretKeys(
  form: Record<string, unknown>,
  original: Record<string, unknown>,
  secretKeys: readonly string[],
): string[] {
  const secretSet = new Set(secretKeys)
  const keys = new Set([...Object.keys(form), ...Object.keys(original)])
  return [...keys].filter(
    (key) => !secretSet.has(key) && comparable(form[key]) !== comparable(original[key]),
  )
}

/**
 * The DESTINATION keys the operator changed — the edits the hub refuses while
 * a secret is left redacted (D634). The kind publishes its `destinationKeys`
 * (`listTargetKinds`); a destination that is itself a secret (the webhook
 * `url`) counts only when re-typed, because a redacted one is kept as is.
 *
 * `destinationKeys` absent means an older hub that does not publish them: then
 * any non-secret edit may be a destination, and the hint stays conservative.
 */
export function editedDestinationKeys(
  form: Record<string, unknown>,
  original: Record<string, unknown>,
  secretKeys: readonly string[],
  destinationKeys: readonly string[] | undefined,
): string[] {
  if (destinationKeys === undefined) return editedNonSecretKeys(form, original, secretKeys)
  const secretSet = new Set(secretKeys)
  const sent = secretMergeDiff(form, original, secretKeys)
  return destinationKeys.filter((key) =>
    secretSet.has(key) ? key in sent : comparable(form[key]) !== comparable(original[key]),
  )
}

/** The secret keys a save would NOT send — each one the hub would restore. */
export function secretsToReenter(
  form: Record<string, unknown>,
  original: Record<string, unknown>,
  secretKeys: readonly string[],
): string[] {
  const sent = secretMergeDiff(form, original, secretKeys)
  return secretKeys.filter((key) => !(key in sent))
}

function markRequired(fields: readonly ConfigField[], keys: ReadonlySet<string>): ConfigField[] {
  return fields.map((field): ConfigField => {
    if (field.type === 'password' && keys.has(field.key)) return { ...field, required: true }
    if (field.type === 'group') return { ...field, fields: markRequired(field.fields, keys) }
    if (field.type === 'sub-tabs') {
      return {
        ...field,
        tabs: field.tabs.map((tab) => ({ ...tab, fields: markRequired(tab.fields, keys) })),
      }
    }
    return field
  })
}

/**
 * The schema with the named password fields marked `required` (the form
 * draws the asterisk). A new schema; the same one when nothing is named.
 */
export function withRequiredSecrets(
  schema: ConfigUISchema,
  secretKeys: readonly string[],
): ConfigUISchema {
  if (secretKeys.length === 0) return schema
  const keys = new Set(secretKeys)
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: markRequired(section.fields, keys),
    })),
  }
}

/**
 * Name for a duplicated target. Always appends ` Copy` so the operator sees
 * it is not the original row.
 */
export function duplicateTargetName(name: string): string {
  const trimmed = name.trim()
  return trimmed.length === 0
    ? i18n.t('common.copy')
    : i18n.t('helpers.notificationTargets.copyOf', { name: trimmed })
}

function withPasswordPlaceholders(
  fields: readonly ConfigField[],
  storedSecrets: ReadonlySet<string>,
): ConfigField[] {
  return fields.map((field): ConfigField => {
    if (field.type === 'password' && storedSecrets.has(field.key)) {
      return {
        ...field,
        placeholder: field.placeholder ?? i18n.t('helpers.notificationTargets.keepSecret'),
      }
    }
    if (field.type === 'group') {
      return { ...field, fields: withPasswordPlaceholders(field.fields, storedSecrets) }
    }
    if (field.type === 'sub-tabs') {
      return {
        ...field,
        tabs: field.tabs.map((tab) => ({
          ...tab,
          fields: withPasswordPlaceholders(tab.fields, storedSecrets),
        })),
      }
    }
    return field
  })
}

/**
 * Password inputs stay visible (masked). When a stored secret exists, show a
 * placeholder so an empty box does not look like a missing field.
 */
export function withStoredSecretPlaceholders(
  schema: ConfigUISchema,
  originalConfig: Record<string, unknown>,
  secretKeys: readonly string[],
): ConfigUISchema {
  const stored = new Set(
    secretKeys.filter((key) => {
      const value = originalConfig[key]
      return value !== undefined && value !== null && value !== ''
    }),
  )
  if (stored.size === 0) return schema
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: withPasswordPlaceholders(section.fields, stored),
    })),
  }
}
