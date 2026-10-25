/**
 * The rule dialog's Devices tab: which devices the rule is restricted to.
 *
 * It used to be a flat checkbox list of CAMERAS ONLY, then a 293-row faceted
 * checklist that took the whole dialog to say "two devices". It is now the
 * smart picker (`DevicePicker`, D636) over EVERY device: the selection as
 * chips over a searchable list grouped by type and room, with select-all /
 * clear per group — ALWAYS open and never paged (`showAll`, R15/D690): this
 * tab exists to show the devices, so it shows all of them.
 *
 * **An empty selection means EVERY device**, not none, which is why the chip
 * row says so in words instead of showing a count of zero.
 *
 * A selected id the ANSWERED fleet lacks (a deleted device) is a removable
 * "Device #<id> — removed" chip, and a failed fleet read draws every selected
 * id by number: without them a rule whose only device was deleted read as
 * "Every device" while it matched nothing. Nothing is dropped from the value on
 * a read (D49); emptying a selection that held devices says the rule now
 * widens to every device.
 *
 * Since D641 the tab is ONE scope field (`RuleScopeField`): "All | Only these |
 * All except these" over this one picker — `conditions.devices` in Only,
 * `conditions.devicesExclude` in Except, nothing in All.
 */

import type { PickerDevice } from './device-picker-model'
import type { DeviceListState } from './device-selection'
import { DevicePicker } from './DevicePicker'
import type { RuleDeviceOption } from './rule-device-filter'
import type { RuleScopeDraft } from './rule-scope-model'
import { RuleScopeField } from './RuleScopeField'
import i18n from '../../i18n/index'

export interface NotificationRuleDevicesProps {
  readonly devices: readonly RuleDeviceOption[]
  readonly value: readonly number[]
  readonly onChange: (next: number[]) => void
  /** Whether `devices` ANSWERED — `[]` is also what an unanswered read looks
   *  like, and only an answer may call an id removed (D315). */
  readonly listState: DeviceListState
  /** Whether the rule as OPENED had devices — seeds the widening warning so it
   *  survives this tab's remount, not only this mount. */
  readonly savedHadDevices: boolean
}

/** A rule device as the picker lists it — its container is the second line. */
export function pickerDeviceOf(device: RuleDeviceOption): PickerDevice {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    location: device.location,
    ...(device.parentName !== undefined ? { detail: device.parentName } : {}),
  }
}

export function NotificationRuleDevices({
  devices,
  value,
  onChange,
  listState,
  savedHadDevices,
}: NotificationRuleDevicesProps) {
  return (
    <DevicePicker
      devices={devices.map(pickerDeviceOf)}
      listState={listState}
      value={value}
      onChange={onChange}
      emptyMeansAll
      savedHadDevices={savedHadDevices}
      noun="device"
      showAll
    />
  )
}

export interface NotificationRuleDeviceScopeProps {
  readonly devices: readonly RuleDeviceOption[]
  readonly scope: RuleScopeDraft<number>
  readonly onChange: (next: RuleScopeDraft<number>) => void
  /** Whether `devices` ANSWERED (D315). */
  readonly listState: DeviceListState
  /** The scope as OPENED — seeds each list's widening warning across a remount. */
  readonly savedScope: RuleScopeDraft<number>
  /** The hub serves `devicesExclude` for this trigger (D641). */
  readonly exceptOffered: boolean
}

/** The Devices tab: the scope pre-selector over the one device picker (D641). */
export function NotificationRuleDeviceScope({
  devices,
  scope,
  onChange,
  listState,
  savedScope,
  exceptOffered,
}: NotificationRuleDeviceScopeProps) {
  const names = new Map(devices.map((device) => [device.id, device.name]))
  return (
    <RuleScopeField
      draft={scope}
      onChange={onChange}
      exceptOffered={exceptOffered}
      plural="devices"
      describe={(id) => names.get(id) ?? i18n.t('uiLibrary.devicePicker.deviceId', { id })}
      testId="rule-device-scope"
      renderPicker={(value, change, mode) => (
        <NotificationRuleDevices
          key={mode}
          devices={devices}
          value={value}
          onChange={change}
          listState={listState}
          savedHadDevices={(mode === 'only' ? savedScope.include : savedScope.exclude).length > 0}
        />
      )}
    />
  )
}
