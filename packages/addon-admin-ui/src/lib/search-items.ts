/**
 * Adapters from the three already-loaded data sources into the flat
 * `SearchItem[]` that `filterSearchItems` (global-search.ts) filters and
 * ranks. Each function is a pure mapping — no fetching, no React — so the
 * expensive "what does the operator have installed" work stays exactly
 * where it already happens (the hooks the sidebar and the Devices /
 * Integrations pages already call) and this module only reshapes it.
 */
import type { DeviceInfo } from '@camstack/types'
import {
  deviceNameNouns,
  indexDeviceNames,
  resolveDeviceLabel,
  resolveParentNames,
  deviceIntegrationResolver,
  deviceTypeMeta,
} from '@camstack/ui-library'
import type { AddonPageInfo } from '../layouts/AddonPageLoader'
import { integrationDetailUrl } from './integration-instance-selection'
import type { SearchItem } from './global-search'
import { type NavSection, resolveAddonPageIcon } from './nav-items'
import i18n from '../i18n/index'

/**
 * The `useIntegrationsList` hook is `typeof trpc.integrations.list.useQuery`
 * — a generic tRPC hook type. `ReturnType<typeof hook>['data']` doesn't
 * resolve to a concrete array outside of an actual call (TS can't pin the
 * generic), so — like `Integrations.tsx` already does for the same hook —
 * this declares only the fields this module reads. The real payload
 * (`IntegrationWithState` in `integrations.cap.ts`) has more fields;
 * structural typing accepts it here.
 */
export interface IntegrationSearchSource {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly enabled: boolean
  readonly processState: string
}

/** Separator between the segments of a result's secondary line — the same
 *  ` · ` the integration and page rows already read as. */
const SUBTITLE_SEPARATOR = ' · '

/**
 * The secondary line under a device result, and the ONLY place the operator
 * can see WHY a row matched an id query.
 *
 * `#102` and the stableId are rendered unconditionally rather than only when
 * they matched: `SearchItem.subtitle` is built once, before any query exists
 * (`filterSearchItems` never rewrites an item), so a query-dependent line
 * would mean a second, query-aware rendering path in the results list. The
 * existing convention is one static subtitle string — this stays inside it.
 *
 * Order is truncation order. `SearchResultsList` truncates the line from the
 * right, so the shortest and most identifying segment goes first and `type`
 * goes last: the type is already carried by the row's own icon, so it is the
 * one segment that costs nothing when it is cut.
 *
 * `#` needs no `t()` — the segments are an id, an opaque stableId and an
 * already-untranslated device type, so this adds no new user-facing string.
 */
function deviceSubtitle(
  device: DeviceInfo,
  idText: string,
  label: string,
  parentName: string | undefined,
): string {
  const segments: string[] = [`#${idText}`]
  // The CONTAINER, ahead of the stableId. Four devices on this fleet are
  // called "Blocco bambini" and nine "Temperatura": the container is the
  // segment that actually answers "which one is this", and the stableId — the
  // segment it displaces — is the opaque one the line truncates away first.
  if (parentName !== undefined) segments.push(parentName)
  // Skipped when the device has no name and the label already IS the
  // stableId — a row reading `#12 · stable-x · stable-x · camera` teaches
  // the operator nothing the first copy didn't.
  if (device.stableId.length > 0 && device.stableId !== label) segments.push(device.stableId)
  segments.push(device.type)
  if (device.disabled) segments.push('disabled')
  return segments.join(SUBTITLE_SEPARATOR)
}

export function buildDeviceSearchItems(
  devices: readonly DeviceInfo[],
  /** `integrations.list`, or `null` while unanswered — then no row gets an
   *  integration keyword (not known is not none). */
  integrations: readonly IntegrationSearchSource[] | null = null,
): readonly SearchItem[] {
  // Resolved once over the whole listing, not per row: the container is a
  // lookup inside the same array, and doing it inside the map would make this
  // quadratic on a 1 096-device fleet.
  const parents = resolveParentNames(devices)
  const nouns = deviceNameNouns(i18n.language.startsWith('it') ? 'it' : 'en')
  const nameIndex = indexDeviceNames(devices)
  // The integration a row BELONGS to, by the one rule (`integrationId`
  // first, `addonId` for legacy rows) — so "blocks" finds a composed device
  // served by `composer` (D659), the way the Devices filter files it.
  const integrationOf = deviceIntegrationResolver(integrations)
  return devices.map((device) => {
    const idText = String(device.id)
    const formatted = resolveDeviceLabel(device, 'compact', nameIndex, nouns)
    const label = formatted.length > 0 ? formatted : device.stableId || `#${idText}`
    const parentName = parents.get(device.id)
    const parentInTitle =
      parentName !== undefined &&
      (label === parentName || label.split(SUBTITLE_SEPARATOR).includes(parentName))
    const resolved = integrationOf(device)
    const integrationName = resolved.kind === 'resolved' ? resolved.integration.name : ''
    return {
      key: `device:${idText}`,
      domain: 'device' as const,
      label,
      subtitle: deviceSubtitle(device, idText, label, parentInTitle ? undefined : parentName),
      // Exact-only (see `SearchItem.identifiers`). `#102` is here as well as
      // `102` because `deviceSubtitle` PRINTS the `#` form — an operator who
      // copies what the row showed him must not get zero results back.
      identifiers: [idText, `#${idText}`],
      // `stableId` stays a KEYWORD, not an identifier: they are long and
      // nobody types a whole one, so it has to match as a substring.
      // The container is a KEYWORD too: "baby" should find the floodlight
      // inside the Baby monitor, which is how an operator actually looks for a
      // child device whose own name says nothing about where it lives.
      keywords: [
        ...(device.name.length > 0 && device.name !== label ? [device.name] : []),
        device.stableId,
        device.addonId,
        device.location ?? '',
        parentName ?? '',
        integrationName,
      ].filter((v): v is string => v.length > 0),
      path: `/devices/${idText}`,
      // Same type→icon single source of truth the Devices page filter and
      // device cards already render from (`DEVICE_TYPE_META` in
      // `@camstack/ui-library`) — reused here rather than a second map that
      // would drift the day a `DeviceType` is added or re-iconed.
      icon: deviceTypeMeta(device.type).icon,
    }
  })
}

export function buildIntegrationSearchItems(
  integrations: readonly IntegrationSearchSource[],
): readonly SearchItem[] {
  return integrations.map((integration) => ({
    key: `integration:${integration.id}`,
    domain: 'integration' as const,
    label: integration.name || integration.addonId,
    subtitle: integration.enabled
      ? integration.addonId
      : i18n.t('helpers.searchItems.disabled', { addonId: integration.addonId }),
    keywords: [integration.addonId, integration.processState],
    path: integrationDetailUrl(integration.addonId, integration.id),
  }))
}

/** Human label for a built-in addon-page section id — mirrors the headers
 *  AppLayout renders above each docked group, so a search subtitle reads
 *  the same as the sidebar section it came from. */
function sectionLabelFor(
  page: AddonPageInfo,
  builtInLabels: Readonly<Record<string, string>>,
  fallback: string,
): string {
  const section = page.section?.trim()
  if (!section) return fallback
  return builtInLabels[section] ?? page.sectionLabel?.trim() ?? section
}

export interface PageSearchItemLabels {
  readonly detection: string
  readonly cluster: string
  readonly administration: string
  readonly ungrouped: string
}

/** Combines the built-in nav registry (nav-items.ts) with dynamically
 *  loaded addon pages into one "page" domain — the registry-reuse the
 *  sidebar itself is built from, so a page that shows up in the sidebar is
 *  always searchable and never listed twice. */
export function buildPageSearchItems(
  navSections: readonly NavSection[],
  addonPages: readonly AddonPageInfo[],
  labels: PageSearchItemLabels,
): readonly SearchItem[] {
  const builtIn: SearchItem[] = navSections.flatMap((section) =>
    section.items.map((item) => ({
      key: `page:${item.path}`,
      domain: 'page' as const,
      label: item.label,
      subtitle: section.label ?? undefined,
      path: item.path,
      icon: item.icon,
      ...(item.keywords !== undefined && item.keywords.length > 0
        ? { keywords: item.keywords }
        : {}),
    })),
  )

  const builtInLabels: Readonly<Record<string, string>> = {
    detection: labels.detection,
    cluster: labels.cluster,
    administration: labels.administration,
  }

  const addon: SearchItem[] = addonPages.map((page) => ({
    key: `page:addon:${page.addonId}:${page.id}`,
    domain: 'page' as const,
    label: page.label,
    subtitle: sectionLabelFor(page, builtInLabels, labels.ungrouped),
    keywords: [page.addonId],
    path: page.path,
    icon: resolveAddonPageIcon(page.icon),
  }))

  return [...builtIn, ...addon]
}
