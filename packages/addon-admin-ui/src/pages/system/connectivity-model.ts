/**
 * Connectivity's data model, pure: which installed addons belong to which
 * group, and what each one's pill says.
 *
 * A group is a `ProviderKind` (`device-export`, `email`, `broker`, `calendar`);
 * its members are the addons whose manifest declares any capability tagged
 * with that kind in its `.cap.ts` (`CAP_PROVIDER_KIND_MAP`, codegen'd). Adding
 * a HomeKit-like exporter therefore needs a `providerKind` tag on its cap and
 * no edit here. `mesh` and `ingress` have their own pages (Network → Mesh /
 * Remote Access). Connectivity shows one SectionedPage section per kind.
 */
import type { ProviderKind } from '@camstack/types'

import type { IntegrationState } from '../../components/integration-hub/types'
import i18n from '../../i18n/index'

/** The fields of an `addons.list` row this page reads. */
export interface ConnectivityRow {
  readonly addonId: string
  readonly displayName: string
  readonly capNames: readonly string[]
  readonly processState: string | null
}

interface RawAddon {
  readonly manifest?: {
    readonly id?: string
    readonly name?: string
    readonly packageDisplayName?: string
    readonly capabilities?: ReadonlyArray<unknown>
  }
  readonly process?: { readonly state?: string }
}

function capNameOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object') {
    const name = (entry as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return null
}

/** Narrow one loosely-typed `addons.list` row; null when it has no id. */
export function toConnectivityRow(raw: unknown): ConnectivityRow | null {
  const typed = raw as RawAddon | null
  const manifest = typed?.manifest
  if (manifest?.id === undefined) return null
  const capNames = (manifest.capabilities ?? [])
    .map(capNameOf)
    .filter((n): n is string => n !== null)
  return {
    addonId: manifest.id,
    displayName: manifest.packageDisplayName ?? manifest.name ?? manifest.id,
    capNames,
    processState: typed?.process?.state ?? null,
  }
}

/** Every capability tagged with `kind`, in the codegen map's order. */
export function capsOfKind(
  kindMap: Readonly<Record<string, ProviderKind>>,
  kind: ProviderKind,
): readonly string[] {
  return Object.entries(kindMap)
    .filter(([, k]) => k === kind)
    .map(([cap]) => cap)
}

/**
 * The capability an addon is driven through on this page — the one its
 * Enable toggle flips and its settings are scoped to. A kind's caps are tried
 * in order, so `broker` (the unified cap) wins over `mqtt-broker` for an addon
 * that declares both.
 */
export function capForRow(row: ConnectivityRow, kindCaps: readonly string[]): string | null {
  return kindCaps.find((cap) => row.capNames.includes(cap)) ?? null
}

/** The process state as a pill state, in words. */
export function processPillState(processState: string | null): {
  readonly state: IntegrationState
  readonly label: string
} {
  switch (processState) {
    case 'running':
      return { state: 'ok', label: i18n.t('helpers.connectivityModel.running') }
    case 'crashed':
    case 'failed':
      return { state: 'error', label: processState }
    case 'stopped':
    case 'disabled':
      return { state: 'off', label: i18n.t('helpers.connectivityModel.stopped') }
    default:
      return { state: 'unknown', label: processState ?? i18n.t('common.unknownWord') }
  }
}
