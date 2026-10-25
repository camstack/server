/**
 * Device-config secret redaction for NON-ADMIN principals.
 *
 * A device's `config` blob is the driver's connection record — host, port,
 * username and, for every IP camera in the deployment, the camera's
 * `password` in plaintext. It rides the wire on every device-manager read:
 * `getDevice`, `listAll`, `getChildren`, and the three settings surfaces that
 * project the same values into form fields.
 *
 * Those methods are declared `auth: 'protected'` (the default in
 * `capability-definition.ts`), which is NOT admin — it is "authenticated, and
 * scope-matched". Measured against the live hub: a scoped token
 * carrying nothing but `category:system` + `view` — a READ-ONLY grant, the one
 * the deploy runbook mints for CI — read `deviceManager.getDevice` and received
 * `config.password` verbatim, and `deviceManager.listAll` answered with a
 * populated password for every camera at once. Read-only access to a device
 * list is not consent to hand over the credentials that open those cameras.
 *
 * WHY HERE, and not at the provider. `toDeviceInfo()` builds one `config` for
 * everybody, and its in-process consumers need the real thing: the pipeline
 * orchestrator's per-camera `getDevice`, dispatch routing, the drivers that
 * actually connect. Those callers arrive through `ctx.api` / UDS and never
 * touch this middleware, so redacting here withholds the secret from the WIRE
 * without blinding the system to its own credentials. The transport boundary
 * is also the only layer that knows the principal.
 *
 * WHY ADMINS ARE UNTOUCHED. The settings form renders the current value into a
 * password field, and `updateConfig` is `auth: 'admin'`, so a redacted value
 * can never be written back by a caller who received one. Making the field
 * write-only for admins too is a bigger, UI-side change; it is not needed to
 * close this hole and would regress the form.
 *
 * Share-view principals never reach this code — they are gated
 * earlier by the fail-closed allowlist in `share-view-access.ts`, which does
 * not expose `getDevice` at all and projects `listAll` down to seven presentation
 * fields. This module is the gate for the tier BETWEEN a share link and an admin.
 *
 * Pure module — no tRPC machinery — so the spec exercises it directly (same
 * pattern as `scope-access.ts` and `share-view-access.ts`).
 */

/** What a non-admin sees instead of the value. Matches the `***` convention
 *  `maskUrlCredentials` already uses for credentials in log output, so one
 *  redaction marker means one thing across the system. */
import { maskUrlCredentials } from '@camstack/types'

export const REDACTED_SECRET = '***'

/**
 * Config keys whose VALUE is a credential.
 *
 * Deliberately the same rule the settings UI uses to decide that a field
 * renders as a password input (`zodEntriesToConfigUI` in
 * `packages/types/src/device/zod-to-config-ui.ts`). The two are pinned
 * together by an assertion in `device-config-secret-redaction.spec.ts`: a
 * keyword added to one and forgotten in the other fails the suite instead of
 * leaking. It is duplicated rather than imported because `@camstack/types` is
 * a framework package on the publish train, and a redaction fix must not have
 * to wait for one.
 */
const SECRET_KEY_SUBSTRINGS: readonly string[] = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
]

/** True when a config key names a credential. Case-insensitive substring match. */
export function isSecretConfigKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SECRET_KEY_SUBSTRINGS.some((needle) => lower.includes(needle))
}

/** Non-null, non-array plain object. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/**
 * One parsed `secretConfigPaths` entry: dotted keys, `[]` for "every element
 * of this array" (`connection.password`, `rows[].pin`). The paths come from
 * the device's own Zod schema — `.meta({ secret: true })` — via
 * `registerDevice` (D783). They are DATA on the row, so this module needs no
 * import from `@camstack/types` to honour them.
 */
type PathSegment = { readonly key: string; readonly each: boolean }

function parsePath(path: string): readonly PathSegment[] {
  return path
    .split('.')
    .filter((part) => part.length > 0)
    .map((part) =>
      part.endsWith('[]') ? { key: part.slice(0, -2), each: true } : { key: part, each: false },
    )
}

/** The declared secret paths a device row advertises, parsed. Absent ⇒ none. */
function declaredPathsOf(row: Record<string, unknown>): readonly (readonly PathSegment[])[] {
  const raw = row['secretConfigPaths']
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is string => typeof p === 'string').map(parsePath)
}

/** Withhold every non-empty string at or below `value` (a declared secret node). */
function withholdAll(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 0 ? REDACTED_SECRET : value
  if (Array.isArray(value)) return value.map(withholdAll)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) out[key] = withholdAll(child)
  return out
}

/** Apply ONE declared path to `value`, returning a copy; a path that does not resolve is a no-op. */
function withholdPath(value: unknown, segments: readonly PathSegment[]): unknown {
  const [head, ...rest] = segments
  if (head === undefined) return withholdAll(value)
  if (!isRecord(value) || !(head.key in value)) return value
  const child = value[head.key]
  const next = head.each
    ? Array.isArray(child)
      ? child.map((el) => withholdPath(el, rest))
      : child
    : withholdPath(child, rest)
  return { ...value, [head.key]: next }
}

/**
 * The keyword BACKSTOP (D634), now at any depth: a credential-NAMED key's
 * string value is withheld, and a non-secret string that is a URL loses its
 * userinfo / credential params. Only strings are touched — a numeric
 * `maxTokens` or an array called `eventTypeTokens` is not a credential.
 *
 * This is no longer the declaration (D783): it catches what a driver has not
 * yet declared, and `scripts/check-secret-fields-declared.ts` is what keeps
 * that set from growing.
 */
function backstop(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes('://') ? maskUrlCredentials(value) : value
  }
  if (Array.isArray(value)) return value.map(backstop)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      isSecretConfigKey(key) && typeof child === 'string' && child.length > 0
        ? REDACTED_SECRET
        : backstop(child)
  }
  return out
}

/**
 * Withhold a device `config` blob's secrets: first every DECLARED path
 * (`secretConfigPaths`, at any depth), then the keyword backstop over what is
 * left.
 *
 * An EMPTY value stays empty: "not configured" and "configured, withheld" are
 * different facts, and flattening them would make a broken camera look set up.
 */
function redactConfigBlob(
  config: Record<string, unknown>,
  declared: readonly (readonly PathSegment[])[],
): Record<string, unknown> {
  let out: unknown = config
  for (const segments of declared) out = withholdPath(out, segments)
  return backstop(out) as Record<string, unknown>
}

/**
 * Project a `DeviceInfo` (or an array of them) with its `config` redacted.
 * Anything that is not a device row passes through untouched — a route that
 * errored upstream must not be rewritten into a plausible-looking shape.
 */
export function redactDeviceInfoSecrets(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((row) => redactDeviceInfoSecrets(row))
  if (!isRecord(data)) return data
  const config = data['config']
  if (!isRecord(config)) return data
  return { ...data, config: redactConfigBlob(config, declaredPathsOf(data)) }
}

/**
 * Project a `Record<parentId, DeviceInfo[]>` — the shape `getChildrenBatch`
 * answers with.
 *
 * {@link redactDeviceInfoSecrets} would pass this through UNTOUCHED: the batch
 * answer IS a record, so `isRecord` accepts it, and it carries no `config` of
 * its own, so the function returns early having redacted nothing. A batch of a
 * single-device read must never be the ungated way to ask the same question.
 */
export function redactDeviceInfoRecordSecrets(data: unknown): unknown {
  if (!isRecord(data)) return data
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) out[key] = redactDeviceInfoSecrets(value)
  return out
}

/**
 * Project a `SettingsSchemaWithValues` (`{ sections: [{ fields: [...] }] }`).
 * Used by `getDeviceSettingsAggregate` and `getSettingsSchema`.
 */
export function redactSettingsSections(data: unknown): unknown {
  if (!isRecord(data)) return data
  const sections = data['sections']
  if (!Array.isArray(sections)) return data
  return {
    ...data,
    sections: sections.map((section) => {
      if (!isRecord(section)) return section
      const fields = section['fields']
      if (!Array.isArray(fields)) return section
      // The same field-aware walk as the addon forms: by TYPE, at any depth,
      // into array rows — a device form carries `password`-typed fields whose
      // key no keyword catches, and HomeKit's pairing `qr-code` (D634 r2).
      return { ...section, fields: fields.map(redactFormField) }
    }),
  }
}

/**
 * Project the combined aggregate, whose settings live one level down under
 * `settings`. The live half carries no config blob.
 */
export function redactSettingsAggregate(data: unknown): unknown {
  if (!isRecord(data)) return data
  const settings = data['settings']
  if (!isRecord(settings)) return data
  return { ...data, settings: redactSettingsSections(settings) }
}

/** True when a hydrated form field carries a credential: by TYPE first, then by name. */
function isSecretFormField(field: Record<string, unknown>): boolean {
  // A `qr-code` in a settings form is a PAIRING code (HomeKit `X-HM://…`):
  // whoever scans it controls the accessory.
  if (field['type'] === 'password' || field['secret'] === true || field['type'] === 'qr-code') {
    return true
  }
  const key = field['key']
  return typeof key === 'string' && isSecretConfigKey(key)
}

/** The `itemFields` of an array field, when it declares them. */
function itemFieldsOf(field: Record<string, unknown> | undefined): readonly unknown[] | undefined {
  const items = field?.['itemFields']
  return Array.isArray(items) ? items : undefined
}

/** The declared item field named `key`, if any. */
function itemField(
  itemFields: readonly unknown[] | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const found = itemFields?.find((f) => isRecord(f) && f['key'] === key)
  return isRecord(found) ? found : undefined
}

/**
 * Withhold every secret inside one form VALUE, whatever its shape.
 *
 * Round 1 replaced only a secret field's string value, so an array of rows
 * (`editable-array` — mqtt-broker `brokers[].password`), a `multiple` secret
 * (an array of strings) and a JSON object holding a `token` all went out
 * whole. So the value is walked: an array element by element, an object key
 * by key — a key is secret when its declared item field is (`password` /
 * `secret: true`) or its NAME is — and everything under a secret is withheld.
 * A non-secret string that is a URL loses its userinfo / credential params
 * (`mqtt://user:pass@host`), the same masker the stream URLs use.
 */
function redactFormValue(
  value: unknown,
  secret: boolean,
  itemFields: readonly unknown[] | undefined,
): unknown {
  if (typeof value === 'string') {
    if (value.length === 0) return value
    if (secret) return REDACTED_SECRET
    return value.includes('://') ? maskUrlCredentials(value) : value
  }
  if (Array.isArray(value)) return value.map((el) => redactFormValue(el, secret, itemFields))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const declared = itemField(itemFields, key)
    const childSecret =
      secret || (declared !== undefined && isSecretFormField(declared)) || isSecretConfigKey(key)
    out[key] = redactFormValue(child, childSecret, itemFieldsOf(declared))
  }
  return out
}

/** One hydrated form field, its secret withheld and its children walked. */
function redactFormField(field: unknown): unknown {
  if (!isRecord(field)) return field
  const nested = field['fields']
  const tabs = field['tabs']
  if (Array.isArray(nested)) return { ...field, fields: nested.map(redactFormField) }
  if (Array.isArray(tabs)) {
    return {
      ...field,
      tabs: tabs.map((tab) => {
        if (!isRecord(tab)) return tab
        const tabFields = tab['fields']
        return Array.isArray(tabFields) ? { ...tab, fields: tabFields.map(redactFormField) } : tab
      }),
    }
  }
  if (!('value' in field)) return field
  const redacted = {
    ...field,
    value: redactFormValue(field['value'], isSecretFormField(field), itemFieldsOf(field)),
  }
  // The HomeKit QR caption spells the setup code out in prose.
  const caption = field['caption']
  return field['type'] === 'qr-code' && typeof caption === 'string' && caption.length > 0
    ? { ...redacted, caption: REDACTED_SECRET }
    : redacted
}

/**
 * Project an ADDON settings form (`addonSettings.getGlobalSettings` /
 * `getIntegrationSettings` / `getDeviceSettings`, a `SettingsSchemaWithValues`).
 *
 * Unlike {@link redactSettingsSections} (device forms, whose secrets are named
 * by key convention) this decides by the FIELD: an addon's credential is often
 * called something no keyword catches — an ntfy `topic`, a PEM `privateKey`
 * marked `secret: true` — and addon forms nest fields in groups and sub-tabs.
 * `hydrateSchema` fills a password field with its stored value on purpose (a
 * masked value clobbered secrets on save), so this boundary is the only place
 * the value is withheld from a non-admin; an admin still gets the real form,
 * and `updateGlobalSettings` / `updateDeviceSettings` are admin-only, so a
 * redacted value can never be written back (D634).
 */
export function redactSettingsForm(data: unknown): unknown {
  if (!isRecord(data)) return data
  const sections = data['sections']
  if (!Array.isArray(sections)) return data
  return {
    ...data,
    sections: sections.map((section) => {
      if (!isRecord(section)) return section
      const fields = section['fields']
      return Array.isArray(fields) ? { ...section, fields: fields.map(redactFormField) } : section
    }),
  }
}

/**
 * Project a `deviceExport.getStatus` answer: drop the `setup` block.
 *
 * `setup` is the export's PAIRING material — HomeKit's `X-HM://` setup URI as
 * `qr`, the Alexa export's Lambda ingress token as a `secret: true` row. The
 * row flag only masks in the UI; the value travels. Only the admin export
 * panel renders it, so a non-admin keeps the link state and counts and never
 * receives the block (D634 r2). One object or a fanned-out array.
 */
export function redactExportSetup(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((row) => redactExportSetup(row))
  if (!isRecord(data) || !('setup' in data)) return data
  const { setup: _setup, ...rest } = data
  return rest
}

/**
 * Walk an arbitrary payload and withhold every secret-NAMED key's value and
 * every URL's credentials — for surfaces with no schema to consult: the raw
 * upstream state a device exposes (Home Assistant attributes carry
 * `access_token` and `?token=` picture URLs), an integration's `info`, a
 * broker list's `url` (D634 r3).
 */
export function redactDeepSecrets(data: unknown): unknown {
  return redactFormValue(data, false, undefined)
}

/** The status-aggregate entry that carries export pairing material. */
const DEVICE_EXPORT_CAP = 'device-export'

/**
 * Project a single status aggregate (`Record<capName, status | null>`): the
 * `device-export` entry loses its `setup` (D634 r3 — defence in depth; the
 * aggregation itself no longer asks a system collection cap per device).
 */
export function redactStatusAggregateSetup(data: unknown): unknown {
  if (!isRecord(data) || !(DEVICE_EXPORT_CAP in data)) return data
  return { ...data, [DEVICE_EXPORT_CAP]: redactExportSetup(data[DEVICE_EXPORT_CAP]) }
}

/** Project a batch status aggregate (`Record<deviceId, Record<capName, status>>`). */
export function redactStatusAggregateBatchSetup(data: unknown): unknown {
  if (!isRecord(data)) return data
  const out: Record<string, unknown> = {}
  for (const [deviceId, statuses] of Object.entries(data)) {
    out[deviceId] = redactStatusAggregateSetup(statuses)
  }
  return out
}

/** Project a flat `ConfigEntry[]` — `getConfigSchema`'s `{ key, value }` rows. */
export function redactConfigEntries(data: unknown): unknown {
  if (!Array.isArray(data)) return data
  return data.map(redactFormField)
}

/**
 * URL fields whose VALUE is an RTSP/RTMP restream address and can embed
 * `user:password@host` userinfo — the camera's own credentials.
 *
 * The stream surfaces (`cameraStreams.getRtspEntries`,
 * `streamBroker.getRtspEntry`, `deviceOps.getStreamSources`, …) hand a
 * non-admin caller `rtsp://admin:hunter2@192.168.10.139/…` verbatim: a
 * read-only token can open every camera by copy-pasting the string. These
 * are NOT config blobs, so {@link redactDeviceInfoSecrets} never sees them — the leak
 * lives in a plain `url` / `mutedUrl` string field.
 */
const URL_FIELD_KEYS: readonly string[] = ['url', 'mutedUrl']

/**
 * Mask the userinfo of every URL-valued field on a stream entry (or array of
 * them), reusing {@link maskUrlCredentials} so ONE masker governs both logs
 * and the wire. A URL with no `user:pass@` (a broker restream whose token is
 * in the path) is returned unchanged, so this is safe to apply broadly.
 *
 * Only the enumerated {@link URL_FIELD_KEYS} are touched; a non-URL string
 * (`codec`, `label`) and a non-string value pass through. Non-row payloads
 * pass through untouched — an upstream error must not be rewritten.
 */
export function redactStreamUrlSecrets(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((row) => redactStreamUrlSecrets(row))
  if (!isRecord(data)) return data
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    out[key] =
      URL_FIELD_KEYS.includes(key) && typeof value === 'string' && value.length > 0
        ? maskUrlCredentials(value)
        : value
  }
  return out
}

/**
 * Mask URL credentials in EVERY string of an arbitrary payload — the runtime
 * state reads (`deviceState.getSnapshot` / `getCapSlice` / `getAllSnapshots`),
 * the status aggregates and `streamCatalog.getCatalog`. Reolink persists its
 * stream catalog (`rtsp://user:pass@…`, FLV `…&password=…`) in the
 * `stream-catalog` slice, so a view-level read handed the camera password to
 * any non-admin (D783). Only strings holding `://` are touched; no key is
 * judged by its name here, so `eventTypeTokens` & co. keep their values.
 */
export function maskUrlCredentialsDeep(data: unknown): unknown {
  if (typeof data === 'string') return data.includes('://') ? maskUrlCredentials(data) : data
  if (Array.isArray(data)) return data.map(maskUrlCredentialsDeep)
  if (!isRecord(data)) return data
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) out[key] = maskUrlCredentialsDeep(value)
  return out
}

/** A response projection applied before the payload leaves the server. */
export type ConfigRedactor = (data: unknown) => unknown

/**
 * Every device-manager read whose response carries a device `config` blob, and
 * the projection that cuts it.
 *
 * ENUMERATED rather than applied blanket-wise on purpose: a structural
 * "redact anything credential-named" pass over every non-admin response would
 * also strip `turnProvider.getTurnServers().credential` (the browser needs it),
 * `auth.listShareTokens().tokenPrefix`, and a notification rule's
 * `conditions.eventTypeTokens` — breaking live surfaces to fix a leak that
 * lives in one cap.
 *
 * `deviceManager.listPersistedByAddon` is absent by inspection, not omission:
 * `SavedDeviceRowSchema` has no `config` field, confirmed against the live hub.
 * A new device-manager method returning `DeviceInfoSchema` must be added here —
 * `device-config-secret-redaction.spec.ts` pins the list so the addition is a
 * failing test rather than a silent leak.
 */
export const NON_ADMIN_CONFIG_REDACTED_METHODS: ReadonlyMap<string, ConfigRedactor> = new Map<
  string,
  ConfigRedactor
>([
  // ── Addon settings forms (D634) — hydrated with the STORED secret ──
  ['addonSettings.getGlobalSettings', redactSettingsForm],
  ['addonSettings.getIntegrationSettings', redactSettingsForm],
  ['addonSettings.getDeviceSettings', redactSettingsForm],
  ['deviceExport.getStatus', redactExportSetup],
  // ── Round-3 sweep: the per-device device-ops twins and the listings ──
  ['deviceOps.getConfigEntries', redactConfigEntries],
  ['deviceOps.getSettingsSchema', redactSettingsSections],
  ['deviceOps.getRawState', redactDeepSecrets],
  ['mqttBroker.listBrokers', redactDeepSecrets],
  ['integrations.list', redactDeepSecrets],
  ['integrations.get', redactDeepSecrets],
  ['integrations.getByAddonId', redactDeepSecrets],
  [
    'deviceManager.getDeviceStatusAggregate',
    (d) => maskUrlCredentialsDeep(redactStatusAggregateSetup(d)),
  ],
  [
    'deviceManager.getDeviceStatusAggregateBatch',
    (d) => maskUrlCredentialsDeep(redactStatusAggregateBatchSetup(d)),
  ],
  ['deviceManager.getDevice', redactDeviceInfoSecrets],
  ['deviceManager.listAll', redactDeviceInfoSecrets],
  ['deviceManager.getChildren', redactDeviceInfoSecrets],
  ['deviceManager.getChildrenBatch', redactDeviceInfoRecordSecrets],
  ['deviceManager.getDeviceSettingsAggregate', redactSettingsSections],
  ['deviceManager.getSettingsSchema', redactSettingsSections],
  ['deviceManager.getDeviceAggregate', redactSettingsAggregate],
  ['deviceManager.getConfigSchema', redactConfigEntries],
  // ── RTSP/RTMP restream URLs (userinfo) — not a config blob, a `url` field ──
  // Every method whose output can carry `rtsp://user:pass@host`. A read-only
  // token reaching these got the camera's own credentials verbatim.
  ['cameraStreams.getCameraStreams', redactStreamUrlSecrets],
  ['cameraStreams.getRtspEntries', redactStreamUrlSecrets],
  ['cameraStreams.getProfileRtspEntries', redactStreamUrlSecrets],
  ['deviceOps.getStreamSources', redactStreamUrlSecrets],
  ['deviceManager.getStreamSources', redactStreamUrlSecrets],
  ['streamBroker.getRtspEntry', redactStreamUrlSecrets],
  ['streamBroker.getAllRtspEntries', redactStreamUrlSecrets],
  // ── Stream catalog + runtime state (D783) — Reolink persists its catalog,
  // credentials inline, in the `stream-catalog` slice. Every URL is masked.
  ['streamCatalog.getCatalog', maskUrlCredentialsDeep],
  ['deviceState.getSnapshot', maskUrlCredentialsDeep],
  ['deviceState.getCapSlice', maskUrlCredentialsDeep],
  ['deviceState.getAllSnapshots', maskUrlCredentialsDeep],
])
