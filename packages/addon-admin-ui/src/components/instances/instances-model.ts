/**
 * The row model of the instances table, pure: which providers of a function cap
 * become instance rows and which stay fixed rows, which providers can create an instance, the
 * three-state answer of the queries behind it, and the patch an edit sends.
 *
 * An unanswered query is never an empty answer (D315): `deriveState` is `pending` until every
 * query has answered, so the caller shows "nothing here" only from `ready`.
 */
import type {
  IntegrationInstance,
  IntegrationInstanceDescription,
  IntegrationInstanceKind,
  IntegrationInstanceMode,
} from '@camstack/types'

/** One provider of the function cap (`log-destination`, `smtp-provider`). */
export interface FunctionProvider {
  readonly addonId: string
  readonly isActive: boolean
}

/** What one `integration-instances` provider answered: its description and its records. */
export interface HolderData {
  readonly addonId: string
  readonly description: IntegrationInstanceDescription
  readonly instances: readonly IntegrationInstance[]
}

export interface InstanceRow {
  readonly kind: 'instance'
  readonly key: string
  readonly addonId: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly configured: boolean
  /** The row's own switch; an off row is quiet, not broken (D62). */
  readonly enabled: boolean
  readonly status: IntegrationInstance['status']
  readonly canTest: boolean
  /** The instance's kind when the provider has kinds; `kindLabel` is what the table shows. */
  readonly kindId?: string
  readonly kindLabel?: string
  /** Epoch ms of the last probe behind `status`. */
  readonly lastCheckedAt?: number
  /** The kind's interactive link / unlink paths (may carry `{{brokerId}}`). */
  readonly connectPath?: string
  readonly disconnectPath?: string
}

export interface FixedRow {
  readonly kind: 'fixed'
  readonly key: string
  readonly addonId: string
  readonly providerName: string
  readonly name: string
  readonly description: string
  readonly isActive: boolean
}

export type PanelRow = InstanceRow | FixedRow

export interface BuildRowsInput {
  readonly functionProviders: readonly FunctionProvider[]
  readonly holders: readonly HolderData[]
  readonly displayNames: ReadonlyMap<string, string>
  readonly descriptions: ReadonlyMap<string, string>
}

/** Instance rows for providers that hold records, fixed rows for the rest, in provider order. */
export function buildRows(input: BuildRowsInput): readonly PanelRow[] {
  const holderById = new Map(input.holders.map((h) => [h.addonId, h]))
  const rows: PanelRow[] = []
  for (const provider of input.functionProviders) {
    const providerName = input.displayNames.get(provider.addonId) ?? provider.addonId
    const holder = holderById.get(provider.addonId)
    if (holder === undefined) {
      rows.push({
        kind: 'fixed',
        key: `fixed:${provider.addonId}`,
        addonId: provider.addonId,
        providerName,
        name: providerName,
        description: input.descriptions.get(provider.addonId) ?? '',
        isActive: provider.isActive,
      })
      continue
    }
    for (const instance of holder.instances) {
      const kind = findKind(holder.description, instance.kind)
      rows.push({
        kind: 'instance',
        key: `${provider.addonId}:${instance.id}`,
        addonId: provider.addonId,
        providerName,
        id: instance.id,
        name: instance.name,
        configured: instance.configured,
        enabled: instance.enabled,
        status: instance.status,
        canTest: holder.description.canTest,
        ...(instance.kind !== undefined ? { kindId: instance.kind } : {}),
        ...(instance.kind !== undefined ? { kindLabel: kind?.label ?? instance.kind } : {}),
        ...(instance.lastCheckedAt !== undefined ? { lastCheckedAt: instance.lastCheckedAt } : {}),
        ...(kind?.connectPath !== undefined ? { connectPath: kind.connectPath } : {}),
        ...(kind?.disconnectPath !== undefined ? { disconnectPath: kind.disconnectPath } : {}),
      })
    }
  }
  return rows
}

/** The kind a record names, among the kinds its provider declared. */
export function findKind(
  description: IntegrationInstanceDescription,
  kindId: string | undefined,
): IntegrationInstanceKind | undefined {
  return kindId === undefined ? undefined : description.kinds?.find((k) => k.id === kindId)
}

/** Whether Add must ask which kind: only when the provider offers a real choice. */
export function needsKindPicker(description: IntegrationInstanceDescription): boolean {
  return (description.kinds?.length ?? 0) > 1
}

/** The word a status badge shows: the provider's own label, else the state. */
export function statusText(status: NonNullable<IntegrationInstance['status']>): string {
  return status.label !== undefined && status.label.length > 0 ? status.label : status.state
}

export interface ProviderChip {
  readonly addonId: string
  readonly name: string
}

/** The distinct providers among the rows, in row order — the activity panel's chips. */
export function providersOf(rows: readonly PanelRow[]): readonly ProviderChip[] {
  const seen = new Set<string>()
  const chips: ProviderChip[] = []
  for (const row of rows) {
    if (seen.has(row.addonId)) continue
    seen.add(row.addonId)
    chips.push({ addonId: row.addonId, name: row.providerName })
  }
  return chips
}

/** The health of one row or of a provider's rows; a hollow dot is `unknown`. */
export type InstanceHealth = 'ok' | 'off' | 'error' | 'unknown'

const HEALTH_SEVERITY: Readonly<Record<InstanceHealth, number>> = {
  error: 3,
  unknown: 2,
  ok: 1,
  off: 0,
}

/** A switched-off row is quiet (D62); otherwise its own status, else configured or not. */
export function rowHealth(row: InstanceRow): InstanceHealth {
  if (!row.enabled) return 'off'
  if (row.status !== undefined) return row.status.state
  return row.configured ? 'ok' : 'unknown'
}

/** The worst of several rows; no rows at all is `unknown`, never a healthy-looking `ok`. */
export function worstHealth(rows: readonly InstanceRow[]): InstanceHealth {
  let worst: InstanceHealth | null = null
  for (const row of rows) {
    const health = rowHealth(row)
    if (worst === null || HEALTH_SEVERITY[health] > HEALTH_SEVERITY[worst]) worst = health
  }
  return worst ?? 'unknown'
}

/** One sub-header pill: a provider of the function cap, with its row count and a status dot. */
export interface InstancePill {
  readonly addonId: string
  readonly name: string
  readonly count: number
  readonly health: InstanceHealth
}

/**
 * A pill for EVERY provider of the function cap, in provider order. A record holder shows its
 * instance count and the worst row status (no record is `unknown`); a fixed-row provider counts
 * its one row and takes its dot from the registry switch (active is `ok`, otherwise `off`).
 */
export function providerPills(
  functionProviders: readonly FunctionProvider[],
  rows: readonly PanelRow[],
  displayNames: ReadonlyMap<string, string>,
): readonly InstancePill[] {
  return functionProviders.map((provider) => {
    const name = displayNames.get(provider.addonId) ?? provider.addonId
    const own = rows.filter((row) => row.addonId === provider.addonId)
    const instances = own.filter((row): row is InstanceRow => row.kind === 'instance')
    const fixed = own.find((row): row is FixedRow => row.kind === 'fixed')
    if (fixed !== undefined) {
      return {
        addonId: provider.addonId,
        name,
        count: 1,
        health: fixed.isActive ? 'ok' : 'off',
      }
    }
    return {
      addonId: provider.addonId,
      name,
      count: instances.length,
      health: worstHealth(instances),
    }
  })
}

/** The rows a pill selects; `null` is the "All" pill. */
export function filterRows(rows: readonly PanelRow[], addonId: string | null): readonly PanelRow[] {
  return addonId === null ? rows : rows.filter((row) => row.addonId === addonId)
}

/**
 * Providers the operator can create an instance in: a `multiple` provider ALWAYS, however many
 * rows it holds; a `single` one only while it has none.
 */
export function creatableProviders(holders: readonly HolderData[]): readonly HolderData[] {
  return holders.filter(
    (h) => h.description.instanceMode === 'multiple' || h.instances.length === 0,
  )
}

export type PanelState = 'pending' | 'error' | 'ready'

export interface QueryFlags {
  readonly isPending: boolean
  readonly isError: boolean
}

/** `error` wins over `pending`; `ready` only when every query answered. */
export function deriveState(queries: readonly QueryFlags[]): PanelState {
  if (queries.some((q) => q.isError)) return 'error'
  if (queries.some((q) => q.isPending)) return 'pending'
  return 'ready'
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (!valuesEqual(left[key], right[key])) return false
  }
  return true
}

/**
 * The patch of an edit: only the keys that differ from the stored values. A secret left alone
 * still holds its stored view, so it is equal and omitted; a typed or cleared one differs.
 */
export function diffInstanceValues(
  stored: Readonly<Record<string, unknown>>,
  edited: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(edited)) {
    if (value === undefined) continue
    if (!valuesEqual(stored[key], value)) patch[key] = value
  }
  return patch
}

/** A single-instance addon names its record after itself; a multi one gets an opaque id. */
export function mintInstanceId(
  mode: IntegrationInstanceMode,
  addonId: string,
  randomHex8: () => string,
): string {
  return mode === 'single' ? addonId : `inst-${randomHex8()}`
}

/** 8 lowercase hex characters from the platform's random source. */
export function randomHex8(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** What an open dialog names: a record, a record about to be created, or a fixed row's settings. */
export type EditRef =
  | { readonly kind: 'instance'; readonly addonId: string; readonly id: string }
  | { readonly kind: 'create'; readonly addonId: string }
  | { readonly kind: 'fixed'; readonly addonId: string }

const CREATE_MARK = '+'

/**
 * The one URL value of an open dialog. `addonId:id` is a record, `addonId:+` a new one and a bare
 * `addonId` a fixed row. An id is only unique inside its provider, so the addon travels with it.
 */
export function formatEditRef(addonId: string, id?: string | null): string {
  if (id === undefined) return addonId
  return `${addonId}:${id === null ? CREATE_MARK : id}`
}

export function parseEditRef(raw: string): EditRef {
  const at = raw.indexOf(':')
  if (at < 0) return { kind: 'fixed', addonId: raw }
  const addonId = raw.slice(0, at)
  const rest = raw.slice(at + 1)
  return rest === CREATE_MARK
    ? { kind: 'create', addonId }
    : { kind: 'instance', addonId, id: rest }
}

export interface PinningTarget {
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
}

/** Names of the notification targets that pin one relay (`smtpInstanceId`): the delete warning and the row hint. */
export function targetsPinning(
  targets: readonly PinningTarget[],
  instanceId: string,
): readonly string[] {
  return targets.filter((t) => t.config['smtpInstanceId'] === instanceId).map((t) => t.name)
}
