/**
 * Provider-declared device identifiers (D1059, planning#590).
 *
 * What a device IS, as its owning provider read it from the hardware: the keys a
 * later step matches across integrations to tell that two devices are the same
 * physical object. Separate from `DeviceMetadata` on purpose — metadata is a
 * free-form blob the operator can edit, identifiers are typed, normalised and
 * written ONLY by the provider that owns the device (`device-manager.
 * setIdentifiers`, owner-checked on the transport's caller stamp).
 *
 * | Key            | Stored form                         | Strength |
 * | -------------- | ----------------------------------- | -------- |
 * | `mac`          | `aa:bb:cc:dd:ee:ff`, several        | strong   |
 * | `serial`       | `<manufacturer>:<serial>`           | strong   |
 * | `machine-uuid` | SMBIOS / VM / container uuid        | strong   |
 * | `vendor-uid`   | `<vendor>:<id>`                     | strong   |
 * | `hostname`     | lower-case, no domain               | weak     |
 * | `ip`           | IPv4 / IPv6                         | weak     |
 *
 * Strength is a property of the KEY, derived by {@link identifierStrength} —
 * never stored, so it cannot drift from the table above. A weak key never links
 * two devices on its own.
 *
 * The schema refuses a value that is not in its stored form, so whatever is
 * persisted is already normalised. Build a declaration with
 * {@link normaliseIdentifiers}, which turns the raw values a driver read into
 * that form and names every value it refused.
 */

import { z } from 'zod'

export const DEVICE_IDENTIFIER_KEYS = [
  'mac',
  'serial',
  'machine-uuid',
  'vendor-uid',
  'hostname',
  'ip',
] as const

export const DeviceIdentifierKeySchema = z.enum(DEVICE_IDENTIFIER_KEYS)
export type DeviceIdentifierKey = z.infer<typeof DeviceIdentifierKeySchema>

/** `read` — the provider read it from the device; `derived` — computed from something else it read. */
export const DeviceIdentifierOriginSchema = z.enum(['read', 'derived'])
export type DeviceIdentifierOrigin = z.infer<typeof DeviceIdentifierOriginSchema>

export type DeviceIdentifierStrength = 'strong' | 'weak'

const MAC_PATTERN = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/
/** `<prefix>:<value>` — prefix a lower-case slug, value lower-case and non-blank. */
const PREFIXED_PATTERN = /^[a-z0-9][a-z0-9._-]*:[^\sA-Z]+$/
const MACHINE_UUID_PATTERN = /^[0-9a-f][0-9a-f-]{7,}$/
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function entrySchema<T extends z.ZodType<string>>(value: T) {
  return z
    .object({
      value,
      origin: DeviceIdentifierOriginSchema,
      /** Epoch ms of the read that produced this value. */
      readAt: z.number().int().nonnegative(),
    })
    .strict()
}

const MacEntrySchema = entrySchema(z.string().regex(MAC_PATTERN))
const SerialEntrySchema = entrySchema(z.string().regex(PREFIXED_PATTERN))
const MachineUuidEntrySchema = entrySchema(z.string().regex(MACHINE_UUID_PATTERN))
const VendorUidEntrySchema = entrySchema(z.string().regex(PREFIXED_PATTERN))
const HostnameEntrySchema = entrySchema(z.string().regex(HOSTNAME_PATTERN))
const IpEntrySchema = entrySchema(z.union([z.ipv4(), z.ipv6()]))

export const DeviceIdentifierEntrySchema = z
  .object({
    value: z.string().min(1),
    origin: DeviceIdentifierOriginSchema,
    readAt: z.number().int().nonnegative(),
  })
  .strict()
export type DeviceIdentifierEntry = z.infer<typeof DeviceIdentifierEntrySchema>

/** The typed declaration. Every key optional; `mac` the only one that holds several. */
export const DeviceIdentifiersSchema = z
  .object({
    mac: z.array(MacEntrySchema).min(1).readonly().optional(),
    serial: SerialEntrySchema.optional(),
    'machine-uuid': MachineUuidEntrySchema.optional(),
    'vendor-uid': VendorUidEntrySchema.optional(),
    hostname: HostnameEntrySchema.optional(),
    ip: IpEntrySchema.optional(),
  })
  .strict()
export type DeviceIdentifiers = z.infer<typeof DeviceIdentifiersSchema>

const STRENGTH: Readonly<Record<DeviceIdentifierKey, DeviceIdentifierStrength>> = {
  mac: 'strong',
  serial: 'strong',
  'machine-uuid': 'strong',
  'vendor-uid': 'strong',
  hostname: 'weak',
  ip: 'weak',
}

/** How much a match on this key says about two devices being the same object. */
export function identifierStrength(key: DeviceIdentifierKey): DeviceIdentifierStrength {
  return STRENGTH[key]
}

/** True when the declaration carries no key at all. */
export function isEmptyIdentifiers(identifiers: DeviceIdentifiers): boolean {
  return DEVICE_IDENTIFIER_KEYS.every((key) => identifiers[key] === undefined)
}

// ── Normalisation ──────────────────────────────────────────────────────────

/** A `<manufacturer>:<serial>` pair as the driver read it. */
export interface RawSerialIdentifier {
  readonly manufacturer: string
  readonly serial: string
}

/** A `<vendor>:<id>` pair as the driver read it. */
export interface RawVendorUidIdentifier {
  readonly vendor: string
  readonly id: string
}

/**
 * The values a driver read, in whatever spelling the device used. Absent,
 * `null` and blank are all "not known".
 */
export interface RawDeviceIdentifiers {
  readonly mac?: string | readonly string[] | null
  readonly serial?: RawSerialIdentifier | null
  readonly machineUuid?: string | null
  readonly vendorUid?: RawVendorUidIdentifier | null
  readonly hostname?: string | null
  readonly ip?: string | null
  /** A connection host as the operator typed it (an address OR a name): it lands
   *  on `ip` or `hostname`, whichever it is. Ignored for a key given explicitly. */
  readonly host?: string | null
}

export interface NormaliseIdentifiersOptions {
  /** Epoch ms of the read. Default: now. */
  readonly readAt?: number
  /** Origin for every key. Default `read`. */
  readonly origin?: DeviceIdentifierOrigin
  /** Per-key origin, over {@link origin}. */
  readonly originByKey?: Readonly<Partial<Record<DeviceIdentifierKey, DeviceIdentifierOrigin>>>
}

/** One value {@link normaliseIdentifiers} refused, and why — the caller logs it. */
export interface RejectedIdentifier {
  readonly key: DeviceIdentifierKey
  readonly value: string
  readonly reason: string
}

export interface NormalisedIdentifiers {
  readonly identifiers: DeviceIdentifiers
  readonly rejected: readonly RejectedIdentifier[]
}

/** Values devices report when they do not know: never an identity. */
const PLACEHOLDER_PATTERN = /^(?:unknown|none|n\/?a|null|undefined|default|0+|-+)$/i

const NULL_MACS: ReadonlySet<string> = new Set(['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'])

export interface AcceptedValue {
  readonly ok: true
  readonly value: string
}
export type NormaliseResult = AcceptedValue | RejectedReason
export interface RejectedReason {
  readonly ok: false
  readonly reason: string
}

function rejected(reason: string): RejectedReason {
  return { ok: false, reason }
}

/** `AA-BB-CC-DD-EE-FF`, `aabb.ccdd.eeff`, `AABBCCDDEEFF` → `aa:bb:cc:dd:ee:ff`. */
export function normaliseMac(raw: string): NormaliseResult {
  const hex = raw
    .trim()
    .toLowerCase()
    .replace(/[\s:.-]/g, '')
  if (!/^[0-9a-f]{12}$/.test(hex)) return rejected('not a 48-bit MAC')
  const mac = (hex.match(/../g) ?? []).join(':')
  if (NULL_MACS.has(mac)) return rejected('placeholder MAC')
  return { ok: true, value: mac }
}

function slug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
}

function normalisePrefixed(prefixRaw: string, valueRaw: string, what: string): NormaliseResult {
  const prefix = slug(prefixRaw)
  if (prefix.length === 0) return rejected(`no ${what}`)
  const value = valueRaw.trim().toLowerCase().replace(/\s+/g, '')
  if (value.length === 0) return rejected('blank value')
  if (PLACEHOLDER_PATTERN.test(value)) return rejected('placeholder value')
  return { ok: true, value: `${prefix}:${value}` }
}

function normaliseMachineUuid(raw: string): NormaliseResult {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^\{|\}$/g, '')
  if (!MACHINE_UUID_PATTERN.test(value)) return rejected('not a uuid')
  if (/^[0-]+$/.test(value) || /^[f-]+$/.test(value)) return rejected('placeholder uuid')
  return { ok: true, value }
}

function isIp(value: string): boolean {
  return z.union([z.ipv4(), z.ipv6()]).safeParse(value).success
}

function normaliseHostname(raw: string): NormaliseResult {
  const full = raw.trim().toLowerCase().replace(/\.$/, '')
  if (full.length === 0) return rejected('blank hostname')
  if (isIp(full)) return rejected('an address, not a hostname')
  const label = full.split('.')[0] ?? ''
  if (!HOSTNAME_PATTERN.test(label)) return rejected('not a hostname')
  if (label === 'localhost') return rejected('placeholder hostname')
  return { ok: true, value: label }
}

function normaliseIp(raw: string): NormaliseResult {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!isIp(value)) return rejected('not an IP address')
  if (value === '0.0.0.0' || value === '::' || value === '::1' || value.startsWith('127.')) {
    return rejected('loopback or unspecified address')
  }
  return { ok: true, value }
}

function isBlank(value: string | null | undefined): value is null | undefined {
  return value === null || value === undefined || value.trim().length === 0
}

/**
 * Turn what a driver read into a valid {@link DeviceIdentifiers}: MACs lower-case
 * with colons and de-duplicated, a hostname without its domain, an IP validated,
 * a serial prefixed by its manufacturer, a vendor uid by its vendor. A value that
 * cannot be normalised is left out and listed in `rejected` — the caller logs it
 * (with `tags: { deviceId }`), it is never dropped in silence.
 */
export function normaliseIdentifiers(
  raw: RawDeviceIdentifiers,
  options: NormaliseIdentifiersOptions = {},
): NormalisedIdentifiers {
  const readAt = options.readAt ?? Date.now()
  const originOf = (key: DeviceIdentifierKey): DeviceIdentifierOrigin =>
    options.originByKey?.[key] ?? options.origin ?? 'read'
  const entry = (key: DeviceIdentifierKey, value: string): DeviceIdentifierEntry => ({
    value,
    origin: originOf(key),
    readAt,
  })
  const refused: RejectedIdentifier[] = []
  const take = (key: DeviceIdentifierKey, input: string, result: NormaliseResult) => {
    if (result.ok) return entry(key, result.value)
    refused.push({ key, value: input, reason: result.reason })
    return undefined
  }

  const macInputs = raw.mac === null || raw.mac === undefined ? [] : [raw.mac].flat()
  const macs: DeviceIdentifierEntry[] = []
  for (const input of macInputs) {
    if (isBlank(input)) continue
    const taken = take('mac', input, normaliseMac(input))
    if (taken !== undefined && !macs.some((m) => m.value === taken.value)) macs.push(taken)
  }

  const serial =
    raw.serial === null || raw.serial === undefined || isBlank(raw.serial.serial)
      ? undefined
      : take(
          'serial',
          `${raw.serial.manufacturer}:${raw.serial.serial}`,
          normalisePrefixed(raw.serial.manufacturer, raw.serial.serial, 'manufacturer'),
        )
  const vendorUid =
    raw.vendorUid === null || raw.vendorUid === undefined || isBlank(raw.vendorUid.id)
      ? undefined
      : take(
          'vendor-uid',
          `${raw.vendorUid.vendor}:${raw.vendorUid.id}`,
          normalisePrefixed(raw.vendorUid.vendor, raw.vendorUid.id, 'vendor'),
        )
  const machineUuid = isBlank(raw.machineUuid)
    ? undefined
    : take('machine-uuid', raw.machineUuid, normaliseMachineUuid(raw.machineUuid))
  const host = isBlank(raw.host) ? null : raw.host.trim()
  const hostIsIp = host !== null && isIp(host.toLowerCase().replace(/^\[|\]$/g, ''))
  const hostnameInput = isBlank(raw.hostname) ? (hostIsIp ? null : host) : raw.hostname
  const ipInput = isBlank(raw.ip) ? (hostIsIp ? host : null) : raw.ip
  const hostname =
    hostnameInput === null
      ? undefined
      : take('hostname', hostnameInput, normaliseHostname(hostnameInput))
  const ip = ipInput === null ? undefined : take('ip', ipInput, normaliseIp(ipInput))

  const identifiers: DeviceIdentifiers = {
    ...(macs.length > 0 ? { mac: macs } : {}),
    ...(serial !== undefined ? { serial } : {}),
    ...(machineUuid !== undefined ? { 'machine-uuid': machineUuid } : {}),
    ...(vendorUid !== undefined ? { 'vendor-uid': vendorUid } : {}),
    ...(hostname !== undefined ? { hostname } : {}),
    ...(ip !== undefined ? { ip } : {}),
  }
  return { identifiers, rejected: refused }
}
