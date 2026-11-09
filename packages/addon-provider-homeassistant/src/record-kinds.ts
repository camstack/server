/**
 * Record kinds owned by the provider-homeassistant addon (records plan
 * phase 2, step 16). The retired `ha-notification-targets` kind is declared by its migration only.
 *
 * The addon declares `execution.placement: hub-only` and no `execution.group`,
 * so the runner id is the addon id: `provider-homeassistant`.
 *
 * Only the `provider-homeassistant` addon declares these kinds. The sibling
 * `homeassistant-export` addon in the same package does NOT own HA notify
 * targets and does not call `ctx.records.declare` here.
 */
import {
  haBrokersEntryKind,
  haCalendarsEntryKind,
  haConnectionsEntryKind,
} from './broker-record-kinds.js'

/** All record kinds this addon declares (the B2 broker entries; the notify targets live in `notify-homeassistant`). */
export const haAllRecordKinds = {
  [haBrokersEntryKind.name]: haBrokersEntryKind,
  [haConnectionsEntryKind.name]: haConnectionsEntryKind,
  [haCalendarsEntryKind.name]: haCalendarsEntryKind,
} as const
