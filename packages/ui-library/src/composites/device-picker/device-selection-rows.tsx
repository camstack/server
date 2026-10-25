/**
 * The words every admin picker uses for a selected id its drawn list does not
 * contain (`device-selection.ts`): "Device #<id> — removed" when the fleet
 * ANSWERED without it, the device's name when the fleet has it (a non-camera
 * on a camera picker), a plain "Device #<id>" when the fleet has not answered.
 * Each is a removable chip in `DevicePicker` — a read never drops a selected
 * id (D49), and only the operator removes one.
 *
 * Since D637 the same words cover the system family's node and package
 * pickers. A node the answered directory lacks is "unknown to the hub", never
 * "removed": even a complete directory omits a node that joined and left
 * between two history captures (`NodeDirectorySchema`). A package the answered
 * list lacks is "not installed". A class the taxonomy lacks is "not in the class
 * list" (D641).
 */

import type { SelectedDeviceRow, SelectionId } from './device-selection'
import { type JSX } from 'react'
import { defaultUiText, useUiText, type UiTextFn } from '../../contexts/ui-text'

/**
 * What a picker lists, for its sentences. `class` is a detection class (D641);
 * `zone` and `face` are a rule's zone and known-face scopes (D690).
 */
export type PickerNoun =
  | 'camera'
  | 'device'
  | 'node'
  | 'package'
  | 'class'
  | 'zone'
  | 'face'
  | 'calendar'

/** Each noun's plural. */
export const PICKER_NOUN_PLURAL: Readonly<Record<PickerNoun, string>> = {
  camera: 'cameras',
  device: 'devices',
  node: 'nodes',
  package: 'packages',
  class: 'classes',
  zone: 'zones',
  face: 'faces',
  calendar: 'calendars',
}

/** What a picker lists, plural — the only words the loading / failed lines say. */
export type PickerNounPlural = (typeof PICKER_NOUN_PLURAL)[PickerNoun]

/** The translated singular of a picker noun. */
export function pickerNounLabel(noun: PickerNoun, t: UiTextFn): string {
  switch (noun) {
    case 'camera':
      return t('uiLibrary.devicePicker.nounCamera', 'camera')
    case 'device':
      return t('uiLibrary.devicePicker.nounDevice', 'device')
    case 'node':
      return t('uiLibrary.devicePicker.nounNode', 'node')
    case 'package':
      return t('uiLibrary.devicePicker.nounPackage', 'package')
    case 'class':
      return t('uiLibrary.devicePicker.nounClass', 'class')
    case 'zone':
      return t('uiLibrary.devicePicker.nounZone', 'zone')
    case 'face':
      return t('uiLibrary.devicePicker.nounFace', 'face')
    case 'calendar':
      return t('uiLibrary.devicePicker.nounCalendar', 'calendar')
  }
}

/** The translated plural of a picker noun. */
export function pickerNounPluralLabel(noun: PickerNoun, t: UiTextFn): string {
  switch (noun) {
    case 'camera':
      return t('uiLibrary.devicePicker.pluralCameras', 'cameras')
    case 'device':
      return t('uiLibrary.devicePicker.pluralDevices', 'devices')
    case 'node':
      return t('uiLibrary.devicePicker.pluralNodes', 'nodes')
    case 'package':
      return t('uiLibrary.devicePicker.pluralPackages', 'packages')
    case 'class':
      return t('uiLibrary.devicePicker.pluralClasses', 'classes')
    case 'zone':
      return t('uiLibrary.devicePicker.pluralZones', 'zones')
    case 'face':
      return t('uiLibrary.devicePicker.pluralFaces', 'faces')
    case 'calendar':
      return t('uiLibrary.devicePicker.pluralCalendars', 'calendars')
  }
}

/** Translates a plural noun the caller passed as its English word. */
function translatePlural(plural: PickerNounPlural, t: UiTextFn): string {
  switch (plural) {
    case PICKER_NOUN_PLURAL.camera:
      return pickerNounPluralLabel('camera', t)
    case PICKER_NOUN_PLURAL.device:
      return pickerNounPluralLabel('device', t)
    case PICKER_NOUN_PLURAL.node:
      return pickerNounPluralLabel('node', t)
    case PICKER_NOUN_PLURAL.package:
      return pickerNounPluralLabel('package', t)
    case PICKER_NOUN_PLURAL.class:
      return pickerNounPluralLabel('class', t)
    case PICKER_NOUN_PLURAL.zone:
      return pickerNounPluralLabel('zone', t)
    case PICKER_NOUN_PLURAL.face:
      return pickerNounPluralLabel('face', t)
    case PICKER_NOUN_PLURAL.calendar:
      return pickerNounPluralLabel('calendar', t)
    default:
      return plural
  }
}

/** The label a picker gives a selected id its drawn list does not contain. */
export function orphanDeviceLabel<Id extends SelectionId>(
  row: SelectedDeviceRow<Id>,
  noun: PickerNoun = 'device',
  t: UiTextFn = defaultUiText,
): string {
  const id = String(row.id)
  switch (noun) {
    case 'node':
      if (row.removed) {
        return t('uiLibrary.devicePicker.nodeUnknown', 'Node {{id}} — unknown to the hub', { id })
      }
      return row.name ?? t('uiLibrary.devicePicker.nodeId', 'Node {{id}}', { id })
    case 'package':
      if (row.removed) {
        return t('uiLibrary.devicePicker.packageNotInstalled', '{{id}} — not installed', { id })
      }
      return row.name ?? id
    // A class the taxonomy does not list is a CUSTOM value (typed on another
    // surface, or a class this hub no longer detects) — kept, never dropped.
    case 'class':
      if (row.removed) {
        return t('uiLibrary.devicePicker.classNotListed', '{{id}} — not in the class list', { id })
      }
      return row.name ?? id
    // A zone that was deleted, or one of a camera the rule no longer lists —
    // and, when its camera's read failed, one nobody can vouch for (D315).
    case 'zone':
      if (row.removed) {
        return t('uiLibrary.devicePicker.zoneNotFound', '{{id}} — zone not found', { id })
      }
      return (
        row.name ?? t('uiLibrary.devicePicker.zoneUnavailable', '{{id}} — zone unavailable', { id })
      )
    // A stored name (pre-id rules) or an identity the gallery no longer has.
    case 'face':
      if (row.removed) {
        return t('uiLibrary.devicePicker.faceNotInGallery', '{{id}} — not in the face gallery', {
          id,
        })
      }
      return row.name ?? id
    case 'calendar':
      if (row.removed) {
        return t('uiLibrary.devicePicker.calendarNotFound', '{{id}} — calendar not found', { id })
      }
      return row.name ?? id
    case 'camera':
    case 'device':
      if (row.removed) {
        return t('uiLibrary.devicePicker.deviceRemoved', 'Device #{{id}} — removed', { id })
      }
      return row.name ?? t('uiLibrary.devicePicker.deviceId', 'Device #{{id}}', { id })
  }
}

interface DevicesWidenWarningProps {
  /** What the picker lists: the rule's Devices tab lists every device. */
  readonly noun?: PickerNoun
}

/** Said under a picker whose empty selection means EVERY device. */
export function DevicesWidenWarning({ noun = 'camera' }: DevicesWidenWarningProps): JSX.Element {
  const t = useUiText()
  return (
    <p className="mt-1 text-[11px] text-warning" data-testid="devices-widen-warning">
      {t(
        'uiLibrary.devicePicker.widenWarning',
        'No {{noun}} selected: the rule will apply to ALL {{plural}}.',
        { noun: pickerNounLabel(noun, t), plural: pickerNounPluralLabel(noun, t) },
      )}
    </p>
  )
}

interface DevicesLoadingLineProps {
  /** What the picker lists, plural — the rule's Devices tab lists every device. */
  readonly noun?: PickerNounPlural
}

/** A list that has not answered: never an absence claim (D315). */
export function DevicesLoadingLine({ noun = 'cameras' }: DevicesLoadingLineProps): JSX.Element {
  const t = useUiText()
  return (
    <p className="text-[11px] text-foreground-subtle">
      {t('uiLibrary.devicePicker.loading', 'Loading {{noun}}…', {
        noun: translatePlural(noun, t),
      })}
    </p>
  )
}

interface DevicesFailedLineProps {
  /** What the picker lists, plural. */
  readonly noun?: PickerNounPlural
}

/** A list that failed: said, while the selected ids stay removable. */
export function DevicesFailedLine({ noun = 'devices' }: DevicesFailedLineProps): JSX.Element {
  const t = useUiText()
  return (
    <p className="text-[11px] text-warning">
      {t(
        'uiLibrary.devicePicker.failed',
        'The hub did not return its {{noun}} — selected ones are listed by id so they can still be removed.',
        { noun: translatePlural(noun, t) },
      )}
    </p>
  )
}
