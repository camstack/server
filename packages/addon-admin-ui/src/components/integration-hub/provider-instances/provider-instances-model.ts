/**
 * The row model of the provider-instances panel, pure: which providers of a function cap
 * become instance rows and which stay fixed rows, which providers can create an instance, the
 * three-state answer of the queries behind it, and the patch an edit sends.
 *
 * An unanswered query is never an empty answer (D315): `deriveState` is `pending` until every
 * query has answered, so the caller shows "nothing here" only from `ready`.
 */
import type {
  IntegrationInstance,
  IntegrationInstanceDescription,
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
  readonly status: IntegrationInstance['status']
  readonly canTest: boolean
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
      rows.push({
        kind: 'instance',
        key: `${provider.addonId}:${instance.id}`,
        addonId: provider.addonId,
        providerName,
        id: instance.id,
        name: instance.name,
        configured: instance.configured,
        status: instance.status,
        canTest: holder.description.canTest,
      })
    }
  }
  return rows
}

/** Providers the operator can create an instance in: several allowed, or one allowed and none yet. */
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
