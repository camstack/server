/**
 * Logging destinations page — every registered `log-destination` provider in
 * one list (Logs → Destinations).
 *
 * A `<InstancesTable>`: a destination that holds its connection as an
 * `integration-instances` record (Loki's URL, credentials and labels) is a row per record,
 * created from a provider picker; a destination with nothing to configure (Winston, Console,
 * the hub forwarder) is a fixed row with its registry switch. Nothing about a destination is
 * hard-coded here.
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
 * Two switches, by what the row is:
 *
 *   - **A record row** (Loki) carries its own `enabled` on the record, switched by
 *     `integrationInstances.setInstanceEnabled`. A record that is off stays in the list, reads
 *     "Off" and ingests nothing; an absent value means on.
 *   - **A fixed row** (Winston, Console, the hub forwarder) has no record, so its switch is the
 *     registry's `disabledProviders` set via `addons.setCapabilityProviderEnabled`, persisted
 *     GLOBALLY under `capabilities.collection.log-destination` — not per node.
 *
 * Restart (per row) bounces the provider's addon on the hub, and the provider's Logs / Events
 * stream sits under the list.
 */
import { ScrollText } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { InstancesTable } from '../../components/instances/InstancesTable'

export function LoggingPage(): ReactElement {
  const { t } = useTranslation()
  return (
    <InstancesTable
      functionCap="log-destination"
      icon={ScrollText}
      title={t('system.logging.destinations', 'Destinations')}
      subtitle={t(
        'system.logging.everyRegisteredLogDestinationEntries',
        'Every registered log destination. Entries are fanned to all enabled destinations at once — enabling one does not disable another.',
      )}
      emptyTitle={t('system.logging.noLogDestinationsRegistered', 'No log destinations registered')}
      emptyDescription={t(
        'system.logging.thisShouldNotHappenThe',
        'This should not happen — the console and rotated-file destinations are builtins. If the list is empty, the node is still booting.',
      )}
      addLabel={t('system.logging.addDestination', 'Add destination')}
      install={{
        capability: 'log-destination',
        label: t('system.logging.installDestination', 'Install a destination'),
      }}
    />
  )
}
