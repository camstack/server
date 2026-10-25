/**
 * Secret-field discovery over a {@link ConfigUISchema}.
 *
 * A provider already declares its own form. That declaration is the ONLY place
 * that knows which of its config keys hold a credential, so redaction reads it
 * rather than keeping a second, hand-maintained key list somewhere in the
 * orchestrator — a list that would be right on the day it was written and
 * wrong on the day a provider gained a field.
 *
 * The discriminator is deliberately NOT `type === 'password'` alone. That was
 * the first design and it is wrong: the SFTP provider's `privateKey` is a
 * `textarea` holding a full PEM key. Keying off the input widget would have
 * left it on the wire while reporting that secrets were redacted. See
 * `ConfigFieldBase.secret`.
 *
 * The walk takes `unknown` because that is what the caller has: the
 * `storage-provider` cap declares `configSchema: z.unknown()`, so a provider's
 * schema arrives structurally unverified. It narrows defensively at every
 * step and ignores anything it cannot read — an unreadable node contributes no
 * keys, which is the direction that under-reports rather than over-reports.
 * A caller that needs "did I understand this schema at all" asks
 * {@link schemaDeclaresAnyField}, which answers `false` for a shape this
 * cannot read, so "no secrets" and "no schema" stay distinguishable.
 */
import type { ConfigField } from './config-ui.js'

/**
 * The value a redacted secret is replaced with on every read surface.
 *
 * It is also the WRITE-BACK token: an `upsertLocation` that sends this value
 * back for a key means "keep what is stored", which is what lets an operator
 * rename a location without retyping its password. A literal an operator could
 * plausibly choose as a real password would turn that convenience into a way
 * to lock yourself out, hence the sentinel shape.
 */
export const REDACTED_SECRET = '__camstack_redacted__'

/** Is this field's stored value a credential? */
export function isSecretConfigField(field: ConfigField): boolean {
  if (field.type === 'password') return true
  return 'secret' in field && field.secret === true
}

/**
 * Is this field's value stored in the KEYCHAIN (D787)? Every secret field is,
 * by its TYPE, unless it opts out with `storage: 'inline'` — never by its name.
 */
export function isKeychainStoredField(field: ConfigField): boolean {
  if (!isSecretConfigField(field)) return false
  // A JSON textarea marked secret because it HOLDS a declared secret somewhere
  // inside (`zodEntriesToConfigUI`) is a structure, not one value: the
  // keychain stores strings, and hiding the whole blob as "set" would make it
  // uneditable. It stays inline (withheld from non-admins, D634/D783) until
  // its secrets are split into fields of their own.
  if (field.type === 'textarea' && field.isJson === true) return false
  return !('storage' in field && field.storage === 'inline')
}

/**
 * Every config key in `schema` whose value is a secret, including keys nested
 * inside `group` / `sub-tabs` containers.
 */
export function collectSecretConfigKeys(schema: unknown): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const section of sectionsOf(schema)) {
    for (const field of fieldsOf(section)) walkField(field, keys)
  }
  return keys
}

/**
 * Every top-level config key whose value the KEYCHAIN stores (D787) —
 * {@link collectSecretConfigKeys} minus `storage: 'inline'` and minus JSON
 * blobs (see {@link isKeychainStoredField}). What a form sends as
 * `secretKeys` so the owner's door knows which values to keep out of the blob.
 */
/** Drop fields marked `omitFromSettings` before an integration settings write. */
export function omitTransientConfig(
  schema: unknown,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const omit = new Set<string>()
  for (const section of sectionsOf(schema)) {
    for (const field of fieldsOf(section)) collectOmitted(field, omit)
  }
  if (omit.size === 0) return config
  const next: Record<string, unknown> = { ...config }
  for (const key of omit) delete next[key]
  return next
}

function collectOmitted(field: unknown, out: Set<string>): void {
  if (!isRecord(field)) return
  const type = field['type']
  const key = field['key']
  if (field['omitFromSettings'] === true && typeof key === 'string' && key.length > 0) {
    out.add(key)
  }
  if (type === 'group') {
    for (const child of fieldsOf(field)) collectOmitted(child, out)
    return
  }
  if (type === 'sub-tabs') {
    const tabs = field['tabs']
    if (!Array.isArray(tabs)) return
    for (const tab of tabs) {
      for (const child of fieldsOf(tab)) collectOmitted(child, out)
    }
  }
}

export function collectKeychainStoredKeys(schema: unknown): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const section of sectionsOf(schema)) {
    for (const field of fieldsOf(section)) walkKeychainField(field, keys)
  }
  return keys
}

function walkKeychainField(field: unknown, out: Set<string>): void {
  if (!isRecord(field)) return
  const type = field['type']
  const key = field['key']
  const isSecret = type === 'password' || field['secret'] === true
  const isJsonBlob = type === 'textarea' && field['isJson'] === true
  if (
    isSecret &&
    !isJsonBlob &&
    field['storage'] !== 'inline' &&
    typeof key === 'string' &&
    key.length > 0
  ) {
    out.add(key)
  }
  if (type === 'group') {
    for (const child of fieldsOf(field)) walkKeychainField(child, out)
    return
  }
  if (type === 'sub-tabs') {
    const tabs = field['tabs']
    if (!Array.isArray(tabs)) return
    for (const tab of tabs) {
      for (const child of fieldsOf(tab)) walkKeychainField(child, out)
    }
  }
}

/**
 * True when the value is a readable schema declaring at least one field of any
 * kind. Lets a caller tell "this provider has no secrets" from "this provider's
 * schema could not be read", which are the same empty set otherwise.
 */
export function schemaDeclaresAnyField(schema: unknown): boolean {
  for (const section of sectionsOf(schema)) {
    if (fieldsOf(section).length > 0) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sectionsOf(schema: unknown): readonly unknown[] {
  if (!isRecord(schema)) return []
  const sections = schema['sections']
  return Array.isArray(sections) ? sections : []
}

function fieldsOf(node: unknown): readonly unknown[] {
  if (!isRecord(node)) return []
  const fields = node['fields']
  return Array.isArray(fields) ? fields : []
}

function walkField(field: unknown, out: Set<string>): void {
  if (!isRecord(field)) return

  const type = field['type']
  const key = field['key']
  const isSecret = type === 'password' || field['secret'] === true
  if (isSecret && typeof key === 'string' && key.length > 0) out.add(key)

  if (type === 'group') {
    for (const child of fieldsOf(field)) walkField(child, out)
    return
  }
  if (type === 'sub-tabs') {
    const tabs = field['tabs']
    if (!Array.isArray(tabs)) return
    for (const tab of tabs) {
      for (const child of fieldsOf(tab)) walkField(child, out)
    }
  }
}
