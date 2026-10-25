/**
 * Stored profile rows of the FLAT shape (before D893) → common fields +
 * `providerConfig`.
 *
 * A flat row kept the provider's fields beside the common ones: `baseUrl`,
 * `extraHeaders` (a map), `runtime` (managed-local) and `appleFoundation`
 * (`{ nodeId }`). They move into `providerConfig` — headers become rows, the
 * runtime is spread (a managed-local `providerConfig` IS a
 * `ManagedRuntimeConfig`), the node id lands as `nodeId`. The API key is NOT
 * moved: the row's keychain slot (`apiKey`, a marker bound to the record's own
 * ref, D878/D879) is the same before and after, so no secret is copied, read
 * or re-written here.
 *
 * Pure and idempotent: a row with no flat field comes back `changed: false`,
 * byte for byte. Nothing is dropped — a value already in `providerConfig`
 * wins over a flat one only when both exist.
 */

/** The fields a flat row kept outside `providerConfig`. */
const FLAT_FIELDS = ['baseUrl', 'extraHeaders', 'runtime', 'appleFoundation'] as const

export interface ProfileBodyMigration {
  readonly body: Record<string, unknown>
  readonly changed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function headerRows(value: unknown): { name: string; value: string }[] | undefined {
  if (Array.isArray(value)) {
    const rows = value.flatMap((row) =>
      isRecord(row) && typeof row.name === 'string' && typeof row.value === 'string'
        ? [{ name: row.name, value: row.value }]
        : [],
    )
    return rows.length > 0 ? rows : undefined
  }
  if (!isRecord(value)) return undefined
  const rows = Object.entries(value).flatMap(([name, v]) =>
    typeof v === 'string' ? [{ name, value: v }] : [],
  )
  return rows.length > 0 ? rows : undefined
}

/** The flat fields of `raw`, as `providerConfig` entries. */
function flatToProviderConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (isRecord(raw.runtime)) Object.assign(out, raw.runtime)
  if (isRecord(raw.appleFoundation) && typeof raw.appleFoundation.nodeId === 'string') {
    out.nodeId = raw.appleFoundation.nodeId
  }
  if (typeof raw.baseUrl === 'string' && raw.baseUrl.length > 0) out.baseUrl = raw.baseUrl
  const headers = headerRows(raw.extraHeaders)
  if (headers !== undefined) out.extraHeaders = headers
  return out
}

export function hasFlatFields(raw: Record<string, unknown>): boolean {
  return FLAT_FIELDS.some((field) => field in raw)
}

export function migrateProfileBody(raw: Record<string, unknown>): ProfileBodyMigration {
  if (!hasFlatFields(raw)) return { body: raw, changed: false }
  const existing = isRecord(raw.providerConfig) ? raw.providerConfig : {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!FLAT_FIELDS.some((field) => field === key)) rest[key] = value
  }
  return {
    body: { ...rest, providerConfig: { ...flatToProviderConfig(raw), ...existing } },
    changed: true,
  }
}
