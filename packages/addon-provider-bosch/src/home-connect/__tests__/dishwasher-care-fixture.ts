/**
 * The dishwasher fixture plus the entities a real SMI4ECS24E lists that the base
 * fixture does not: the remote-control level (a SETTING, not a status), the filter
 * and machine-care reminders (events) and the machine-care run counter (a status).
 * Names are the ones that appliance's own IDDF carries; the uids are this fixture's.
 */
import { HomeConnectDescriptionStore } from '../home-connect-description-store.js'
import { parseHomeConnectIddfXml } from '../home-connect-device-description.js'
import {
  DISHWASHER_DEVICE_DESCRIPTION_XML,
  DISHWASHER_FEATURE_MAPPING_XML,
  HA_ID,
} from './dishwasher-iddf-fixture.js'

const EVENT = (uid: string) =>
  `<event access="read" available="true" enumerationType="200D" handling="none" level="hint" refCID="03" refDID="80" uid="${uid}"/>`

export const CARE_NAMES = {
  remoteControlLevel: 'BSH.Common.Setting.RemoteControlLevel',
  smartFilter: 'Dishcare.Dishwasher.Event.SmartFilterCleaningReminder',
  machineCare: 'Dishcare.Dishwasher.Event.MachineCareReminder',
  machineCareAndFilter: 'Dishcare.Dishwasher.Event.MachineCareAndFilterCleaningReminder',
  checkFilter: 'Dishcare.Dishwasher.Event.CheckFilterSystem',
  careRuns: 'Dishcare.Dishwasher.Status.MachineCareReminder.RemainingProgramRuns',
} as const

const DEVICE_XML = DISHWASHER_DEVICE_DESCRIPTION_XML.replace(
  '</statusList>',
  '<status access="read" available="true" min="0" max="100" stepSize="1" refCID="02" refDID="00" uid="0334"/></statusList>',
)
  .replace(
    '</settingList>',
    '<setting access="readWrite" available="true" refCID="01" refDID="00" uid="0250"/></settingList>',
  )
  .replace(
    '</eventList>',
    `${EVENT('0330')}${EVENT('0331')}${EVENT('0332')}${EVENT('0333')}</eventList>`,
  )

const MAPPING_XML = DISHWASHER_FEATURE_MAPPING_XML.replace(
  '</featureDescription>',
  `<feature refUID="0250">${CARE_NAMES.remoteControlLevel}</feature>
    <feature refUID="0330">${CARE_NAMES.smartFilter}</feature>
    <feature refUID="0331">${CARE_NAMES.machineCare}</feature>
    <feature refUID="0332">${CARE_NAMES.machineCareAndFilter}</feature>
    <feature refUID="0333">${CARE_NAMES.checkFilter}</feature>
    <feature refUID="0334">${CARE_NAMES.careRuns}</feature>
  </featureDescription>`,
)

export function careDescription(): HomeConnectDescriptionStore {
  return new HomeConnectDescriptionStore(
    JSON.parse(
      JSON.stringify(
        parseHomeConnectIddfXml({
          deviceDescriptionXml: DEVICE_XML,
          featureMappingXml: MAPPING_XML,
          haId: HA_ID,
        }),
      ),
    ),
  )
}
