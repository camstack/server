/**
 * Persistence for notification targets over the per-kind record kinds (epic #440, step 6).
 *
 * `TargetStore.of(records)` is the `Target`-shaped facade the provider keeps using: a target is stored
 * as a flat body in the record kind of its target kind, secrets in the keychain. Kinds are declared at
 * addon boot via `ctx.records.declare(notifiersRecordKinds)` before the store is built. The mechanics
 * (list / resolve / upsert / delete / switch) are shared with the other notification providers.
 */
import {
  NotificationTargetStore,
  type NotificationTargetStoreOptions,
  notificationTargetKinds,
  type RecordsAccess,
  type TargetKind,
} from '@camstack/types'
import { notifierDescriptors } from './record-kinds.js'

export type TargetStore = NotificationTargetStore

export const TargetStore = {
  /** `descriptors` default to the catalog; a spec with its own adapters names theirs. */
  of(
    records: Pick<RecordsAccess, 'kind'>,
    descriptors: readonly TargetKind[] = notifierDescriptors(),
    options: NotificationTargetStoreOptions = {},
  ): TargetStore {
    return NotificationTargetStore.of(
      records,
      'notifiers',
      notificationTargetKinds(descriptors),
      descriptors,
      options,
    )
  },
}
