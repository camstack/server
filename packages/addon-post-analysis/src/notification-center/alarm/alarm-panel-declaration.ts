/**
 * The Notification Center's alarm panel, as a DECLARATION.
 *
 * There is no `ensureAlarmPanel` any more. The get-or-create, the `fixed`
 * re-assertion, the adopt-don't-skip rule and the hub-ownership gate all moved
 * to `DeclaredDevices` in `@camstack/types` — the one primitive for a device an
 * addon declares. What is left here is the *declaration*: the stable id, the
 * seed name, the type and the class. Data, not procedure.
 *
 * The bug the hand-rolled version carried died in that move: it read the device
 * index once, so a transiently empty answer took the create branch and
 * re-stamped `Alarm` over the operator's rename. `DeclaredDevices` requires a
 * second read to agree before it does anything destructive (D49).
 */

import { type DeviceDeclaration, DeviceType } from '@camstack/types'
import { NcAlarmPanelDevice } from './alarm-panel-device.js'

/** Stable id of the one panel. Never derived from a name — a rename must not
 *  mint a second device. */
const NC_ALARM_STABLE_ID = 'nc-alarm-panel'

/** Seeded ONCE, at create. A later boot never re-stamps it. */
const NC_ALARM_DEVICE_NAME = 'Alarm'

/** Display name of the FIXED integration the panel hangs from. */
export const NC_INTEGRATION_NAME = 'Notification Center'

export const NC_ALARM_DECLARATION: DeviceDeclaration = {
  stableId: NC_ALARM_STABLE_ID,
  name: NC_ALARM_DEVICE_NAME,
  type: DeviceType.AlarmPanel,
  DeviceClass: NcAlarmPanelDevice,
}
