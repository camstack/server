/**
 * Record kinds owned by the notifiers addon: one per target kind (ntfy, telegram, webhook, ...).
 *
 * The addon has `execution.placement: hub-only` and `execution.group: "notifiers"`. The UDS stamp on
 * every record is the RUNNER id (= the group id): `notifiers`.
 *
 * A target is an instance of the function cap `notification-output` (epic #440, step 6): its record
 * body IS the kind's form, lifted from the adapter's `configSchema` by `defineNotificationTargetKind`
 * (a `password` field is a keychain secret, an `instance-select` field a link). The shared lifting,
 * the `Target`-shaped facade and the `integration-instances` provider live in `@camstack/types`
 * (`notification-targets.ts`); this file only names the descriptors this addon serves.
 */
import { notificationTargetKinds, type TargetKind } from '@camstack/types'
import { buildNotifierAdapters } from './adapters/registry.js'

/** The descriptors of the catalog, by kind. The email adapter's live options do not change its fields. */
export function notifierDescriptors(): readonly TargetKind[] {
  return buildNotifierAdapters().map((adapter) => adapter.descriptor)
}

export const notifiersRecordKinds = notificationTargetKinds(notifierDescriptors())
