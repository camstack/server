/**
 * Logging destinations page — every registered `log-destination` provider,
 * one at a time (Logs → Destinations).
 *
 * An `<IntegrationHub>`, the same base Remote Access uses, so the pills,
 * Enable/Disable, Restart, the schema settings and the activity stream all come
 * for free. Each destination's own configuration — Winston's level and
 * retention, Loki's URL and labels — is its `globalSettingsSchema()`, rendered
 * by the base's Settings section. Nothing about a destination is hard-coded here.
 *
 * ## Why no `logging` orchestrator capability
 *
 * Storage and Backup each have a singleton orchestrator cap behind their page,
 * because they own state the page mutates: locations, policies, retention. Logging
 * has none — every destination already owns its settings, `LogManager` already fans
 * every entry to all of them, and enable/disable is a registry-level concern that
 * `addons.setCapabilityProviderEnabled` already handles for any collection cap.
 *
 * `log-destination` is `internal: true` with `mount: { kind: 'skip' }`, so it has
 * no tRPC route and no generated hooks — but `addons.listCapabilityProviders`
 * takes a `capName` and works for internal caps too, which is exactly what is
 * needed to enumerate them. Adding a facade cap would have meant a codegen change,
 * a framework publish and a second place for a destination's identity to live, to
 * gain nothing.
 *
 * ## What "enabled" means here
 *
 * Two independent switches, and the distinction matters:
 *
 *   - **Enable/Disable** (this page, per row) flips the registry's
 *     `disabledProviders` set via `addons.setCapabilityProviderEnabled`. A disabled
 *     provider stops receiving entries. Persisted GLOBALLY under
 *     `capabilities.collection.log-destination` — not per node.
 *   - **A destination's own `enabled` setting** (Loki has one) lives in its addon
 *     settings and IS per node. Loki also stays inert without a URL.
 *
 * So a destination can be registry-enabled and still do nothing, which is why the
 * badges below report configuration state separately rather than collapsing both
 * into one "on" indicator.
 */
import { useMemo, type ReactElement } from 'react'
import { FileText, ScrollText } from 'lucide-react'
import { useAddonsList, useAddonsListCapabilityProviders } from '@camstack/ui-library'
import { AddonIntegrationBody } from '../../components/integration-hub/AddonIntegrationBody'
import { IntegrationHub } from '../../components/integration-hub/IntegrationHub'
import { providerPillState, type IntegrationGroup } from '../../components/integration-hub/types'
import { buildAddonDisplayNameMap } from '../../lib/addon-display-names'
import { useTranslation } from 'react-i18next'

const POLL_INTERVAL_MS = 5_000
const CAPABILITY = 'log-destination'

/**
 * What each builtin destination does, in one line. Keyed by addon id and used only
 * as a fallback caption — an installed addon's own manifest `description` wins, so
 * a third-party log destination is described by its author rather than by this map.
 */
const KNOWN_DESTINATIONS: Readonly<Record<string, string>> = {
  'winston-logging': 'Rotated log files on this node’s disk.',
  'console-logging': 'stdout / stderr of the node process.',
  'loki-logging': 'Pushes to a Grafana Loki instance. Off until enabled with a URL.',
  'hub-forwarder': 'Agent-only — forwards this node’s entries to the hub.',
}

interface LogDestinationRow {
  readonly addonId: string
  readonly displayName: string
  readonly isActive: boolean
  readonly caption: string
}

export function LoggingPage(): ReactElement {
  const { t } = useTranslation()
  const providersQuery = useAddonsListCapabilityProviders(
    { capName: 'log-destination' },
    { refetchInterval: POLL_INTERVAL_MS },
  )
  const addonsQuery = useAddonsList(undefined, { refetchInterval: POLL_INTERVAL_MS })

  const displayNames = useMemo(
    () => buildAddonDisplayNameMap(addonsQuery.data ?? []),
    [addonsQuery.data],
  )

  /** addonId → manifest description, so an addon describes itself. */
  const descriptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const addon of addonsQuery.data ?? []) {
      const description = (addon as { description?: unknown }).description
      const id = (addon as { id?: unknown }).id
      if (typeof id === 'string' && typeof description === 'string' && description.length > 0) {
        map.set(id, description)
      }
    }
    return map
  }, [addonsQuery.data])

  const destinations = useMemo<readonly LogDestinationRow[]>(
    () =>
      (providersQuery.data ?? []).map((p) => ({
        addonId: p.addonId,
        displayName: displayNames.get(p.addonId) ?? p.addonId,
        isActive: p.isActive,
        caption: descriptions.get(p.addonId) ?? KNOWN_DESTINATIONS[p.addonId] ?? '',
      })),
    [providersQuery.data, displayNames, descriptions],
  )

  const groups: readonly IntegrationGroup[] = [
    {
      id: CAPABILITY,
      label: t('system.logging.logDestinations', 'Log destinations'),
      entries: destinations.map((d) => ({
        id: d.addonId,
        name: d.displayName,
        fallbackIcon: FileText,
        ...providerPillState(d.isActive),
        render: () => (
          <AddonIntegrationBody
            addonId={d.addonId}
            displayName={d.displayName}
            capName={CAPABILITY}
            isActive={d.isActive}
            badges={
              d.caption.length > 0 ? (
                <span className="text-[11px] text-foreground-subtle">{d.caption}</span>
              ) : null
            }
          />
        ),
      })),
    },
  ]

  return (
    <IntegrationHub
      embedded
      icon={ScrollText}
      title={t('system.logging.destinations', 'Destinations')}
      subtitle={t(
        'system.logging.everyRegisteredLogDestinationEntries',
        'Every registered log destination. Entries are fanned to all enabled destinations at once — enabling one does not disable another.',
      )}
      groups={groups}
      isLoading={providersQuery.isLoading}
      emptyTitle={t('system.logging.noLogDestinationsRegistered', 'No log destinations registered')}
      emptyDescription={t(
        'system.logging.thisShouldNotHappenThe',
        'This should not happen — the console and rotated-file destinations are builtins. If the list is empty, the node is still booting.',
      )}
    />
  )
}
