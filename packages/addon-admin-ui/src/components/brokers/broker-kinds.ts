/**
 * The one place that turns the `broker` cap's wire data into what the broker UI
 * needs: the list of brokers, and the kinds an operator can create with the
 * provider that serves each. `BrokerPicker`, `BrokerEditorDialog`,
 * `BrokerManager` and the record-entries panel all read through here, so a
 * kind's owning addon, interactive-connect paths and sign-in contract are
 * resolved once. Kind VALUES are data; nothing here branches on one.
 */
import { useMemo } from 'react'
import { useBrokerList, useBrokerListProviders } from '@camstack/ui-library'
import type { BrokerSignInMethod } from '../../lib/broker-sign-in'
import type { BrokerProviderInfo, UnifiedBrokerInfo } from '@camstack/types'

/** A kind the operator can create, with the provider that serves it. */
export interface BrokerKindOption {
  /** Owning addon; absent for a kind seen only on an existing broker. */
  readonly addonId?: string
  readonly kind: string
  readonly label: string
  readonly interactiveConnectPath?: string
  readonly interactiveDisconnectPath?: string
  /** Hub-relative base of the kind's interactive sign-in routes (see `broker.cap.ts`). */
  readonly signInBasePath?: string
  /** Sign-in methods in preference order; absent means the guided proxy only. */
  readonly signInMethods?: readonly BrokerSignInMethod[]
}

/** `addonId::kind`: a kind served by two providers stays two options. */
export function kindOptionKey(option: BrokerKindOption | undefined): string {
  return option === undefined ? '' : `${option.addonId ?? ''}::${option.kind}`
}

export function asBrokerList(data: unknown): readonly UnifiedBrokerInfo[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (b): b is UnifiedBrokerInfo =>
      b !== null && typeof b === 'object' && typeof (b as { id?: unknown }).id === 'string',
  )
}

export function asProviderList(data: unknown): readonly BrokerProviderInfo[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (p): p is BrokerProviderInfo =>
      p !== null &&
      typeof p === 'object' &&
      typeof (p as { addonId?: unknown }).addonId === 'string' &&
      Array.isArray((p as { kinds?: unknown }).kinds),
  )
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export interface BuildKindOptionsInput {
  readonly providers: readonly BrokerProviderInfo[]
  /** Brokers that already exist: a kind seen only here still gets an (addon-less) option. */
  readonly brokers: readonly UnifiedBrokerInfo[]
  /** Narrow to one provider's kinds. */
  readonly addonId?: string
  /** Narrow to one kind. */
  readonly kind?: string
}

export function buildKindOptions(input: BuildKindOptionsInput): readonly BrokerKindOption[] {
  const seen = new Map<string, BrokerKindOption>()
  for (const provider of input.providers) {
    if (input.addonId !== undefined && provider.addonId !== input.addonId) continue
    for (const k of provider.kinds) {
      if (input.kind !== undefined && k.kind !== input.kind) continue
      const connect = nonEmpty(k.interactiveConnectPath)
      const disconnect = nonEmpty(k.interactiveDisconnectPath)
      const signIn = nonEmpty(k.signIn?.basePath)
      seen.set(`${provider.addonId}::${k.kind}`, {
        addonId: provider.addonId,
        kind: k.kind,
        label: k.label,
        ...(connect !== undefined ? { interactiveConnectPath: connect } : {}),
        ...(disconnect !== undefined ? { interactiveDisconnectPath: disconnect } : {}),
        ...(signIn !== undefined ? { signInBasePath: signIn } : {}),
        ...(signIn !== undefined && k.signIn?.methods !== undefined && k.signIn.methods.length > 0
          ? { signInMethods: k.signIn.methods }
          : {}),
      })
    }
  }
  for (const b of input.brokers) {
    if (input.kind !== undefined && b.kind !== input.kind) continue
    const hasKind = [...seen.values()].some((k) => k.kind === b.kind)
    if (!hasKind) seen.set(`::${b.kind}`, { kind: b.kind, label: b.kind })
  }
  return [...seen.values()]
}

export interface UseBrokerKindsResult {
  readonly options: readonly BrokerKindOption[]
  readonly isLoading: boolean
}

/** The creatable kinds (optionally narrowed to one provider or one kind). */
export function useBrokerKinds(filter: {
  readonly addonId?: string
  readonly kind?: string
}): UseBrokerKindsResult {
  const providersQuery = useBrokerListProviders()
  const listQuery = useBrokerList(filter.kind !== undefined ? { kind: filter.kind } : {})
  const options = useMemo(
    () =>
      buildKindOptions({
        providers: asProviderList(providersQuery.data),
        brokers: asBrokerList(listQuery.data).filter(
          (b) => filter.addonId === undefined || b.addonId === filter.addonId,
        ),
        ...(filter.addonId !== undefined ? { addonId: filter.addonId } : {}),
        ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
      }),
    [providersQuery.data, listQuery.data, filter.addonId, filter.kind],
  )
  return { options, isLoading: providersQuery.isLoading === true }
}
