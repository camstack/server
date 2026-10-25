/**
 * A dishwasher IDDF pair in the shape the cloud archive carries: one
 * `DeviceDescription.xml` (lists of status / setting / event / command / option
 * entities, program groups whose programs reference options by `refUID`, and the
 * active / selected program entities) and one `FeatureMapping.xml` (uid -> feature
 * name, enum members). Feature NAMES are the published Home Connect ones; the uids
 * are this fixture's own and deliberately differ from any one model's, so a spec
 * that passes here cannot be leaning on a hard-coded uid.
 *
 * Two entities have no mapping row on purpose (`0x0999`, `0x0998`): the IDDF can
 * declare things the mapping does not name, and those must still surface.
 */
import { HomeConnectDescriptionStore } from '../home-connect-description-store.js'
import { parseHomeConnectIddfXml } from '../home-connect-device-description.js'

export const DISHWASHER_DEVICE_DESCRIPTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<device xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <description>
    <type>Dishwasher</type>
    <brand>Bosch</brand>
    <model>SMV4HCX48E</model>
    <version>2</version>
    <revision>0</revision>
  </description>
  <statusList>
    <status access="read" available="true" refCID="01" refDID="00" uid="0005"/>
    <status access="read" available="true" refCID="01" refDID="00" uid="0205"/>
    <status access="read" available="true" refCID="01" refDID="00" uid="020B"/>
    <status access="read" available="true" enumerationType="2009" refCID="03" refDID="80" uid="020F"/>
    <status access="read" available="true" enumerationType="200A" refCID="03" refDID="80" uid="0228"/>
    <status access="read" available="true" refCID="01" refDID="00" uid="0210"/>
    <status access="read" available="true" enumerationType="200B" refCID="03" refDID="80" uid="0230"/>
    <status access="read" available="true" min="0" max="100" stepSize="1" refCID="02" refDID="00" uid="0999"/>
  </statusList>
  <settingList>
    <setting access="readWrite" available="true" enumerationType="200C" refCID="03" refDID="80" uid="021B"/>
    <setting access="readWrite" available="true" refCID="01" refDID="00" uid="0204"/>
    <setting access="readWrite" available="true" min="1" max="5" stepSize="1" refCID="02" refDID="00" uid="0240"/>
    <setting access="readWrite" available="true" refCID="01" refDID="00" uid="0998"/>
  </settingList>
  <eventList>
    <event access="read" available="true" enumerationType="200D" handling="acknowledge" level="info" refCID="03" refDID="80" uid="0310"/>
    <event access="read" available="true" enumerationType="200D" handling="none" level="hint" refCID="03" refDID="80" uid="0311"/>
    <event access="read" available="true" enumerationType="200D" handling="none" level="hint" refCID="03" refDID="80" uid="0312"/>
    <event access="read" available="true" enumerationType="200D" handling="acknowledge" level="alert" refCID="03" refDID="80" uid="0313"/>
    <event access="read" available="true" enumerationType="200D" handling="acknowledge" level="warning" refCID="03" refDID="80" uid="0316"/>
    <event access="read" available="true" enumerationType="200D" handling="acknowledge" level="warning" refCID="03" refDID="80" uid="0317"/>
  </eventList>
  <commandList>
    <command access="writeOnly" available="true" refCID="01" refDID="00" uid="0320"/>
    <command access="writeOnly" available="true" refCID="01" refDID="00" uid="0321"/>
    <command access="writeOnly" available="false" refCID="01" refDID="00" uid="0322"/>
  </commandList>
  <optionList>
    <option access="readWrite" available="true" liveUpdate="true" min="0" max="86340" stepSize="60" refCID="02" refDID="00" uid="022E"/>
    <option access="read" available="true" liveUpdate="true" min="0" max="86400" stepSize="1" refCID="02" refDID="00" uid="0220"/>
    <option access="read" available="true" liveUpdate="true" min="0" max="100" stepSize="1" refCID="02" refDID="00" uid="021E"/>
    <option access="read" available="true" min="0" max="100" stepSize="1" refCID="02" refDID="00" uid="0231"/>
    <option access="read" available="true" min="0" max="100" stepSize="1" refCID="02" refDID="00" uid="0232"/>
    <option access="read" available="true" min="0" max="5000" stepSize="1" refCID="02" refDID="00" uid="0233"/>
    <option access="read" available="true" min="0" max="50" stepSize="1" refCID="02" refDID="00" uid="0234"/>
    <option access="readWrite" available="true" refCID="01" refDID="00" uid="4101"/>
    <option access="readWrite" available="true" refCID="01" refDID="00" uid="4102"/>
    <option access="readWrite" available="true" refCID="01" refDID="00" uid="4103"/>
    <option access="readWrite" available="true" refCID="01" refDID="00" uid="4104"/>
  </optionList>
  <programGroup uid="4000">
    <program available="true" uid="4010">
      <option refUID="022E" access="readWrite" available="true"/>
      <option refUID="4101" access="readWrite" available="true" default="false"/>
      <option refUID="4102" access="readWrite" available="true" default="false"/>
      <option refUID="4104" access="read" available="false" default="true"/>
    </program>
    <program available="true" uid="4011">
      <option refUID="022E" access="readWrite" available="true"/>
      <option refUID="4101" access="readWrite" available="true" default="true"/>
      <option refUID="4103" access="readWrite" available="true" default="false"/>
    </program>
    <program available="false" uid="4012">
      <option refUID="022E" access="read" available="false"/>
    </program>
  </programGroup>
  <activeProgram access="readWrite" validate="true" uid="0100"/>
  <selectedProgram access="readWrite" fullOptionSet="false" uid="0101"/>
  <protectionPort uid="0102"/>
  <enumerationTypeList>
    <enumerationType enid="2009"/>
  </enumerationTypeList>
</device>`

export const DISHWASHER_FEATURE_MAPPING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<featureMappingFile>
  <featureDescription>
    <feature refUID="0005">BSH.Common.Status.BackendConnected</feature>
    <feature refUID="0205">BSH.Common.Status.RemoteControlStartAllowed</feature>
    <feature refUID="020B">BSH.Common.Status.RemoteControlActive</feature>
    <feature refUID="020F">BSH.Common.Status.DoorState</feature>
    <feature refUID="0228">BSH.Common.Status.OperationState</feature>
    <feature refUID="0210">BSH.Common.Status.LocalControlActive</feature>
    <feature refUID="0230">Dishcare.Dishwasher.Status.ProgramPhase</feature>
    <feature refUID="021B">BSH.Common.Setting.PowerState</feature>
    <feature refUID="0204">BSH.Common.Setting.ChildLock</feature>
    <feature refUID="0240">BSH.Common.Setting.Brightness</feature>
    <feature refUID="0310">BSH.Common.Event.ProgramFinished</feature>
    <feature refUID="0311">Dishcare.Dishwasher.Event.SaltNearlyEmpty</feature>
    <feature refUID="0312">Dishcare.Dishwasher.Event.RinseAidNearlyEmpty</feature>
    <feature refUID="0313">BSH.Common.Event.ProgramAborted</feature>
    <feature refUID="0316">Dishcare.Dishwasher.Event.RinseAidLack</feature>
    <feature refUID="0317">Dishcare.Dishwasher.Event.SaltLack</feature>
    <feature refUID="0320">BSH.Common.Command.PauseProgram</feature>
    <feature refUID="0321">BSH.Common.Command.ResumeProgram</feature>
    <feature refUID="0322">BSH.Common.Command.AbortProgram</feature>
    <feature refUID="022E">BSH.Common.Option.StartInRelative</feature>
    <feature refUID="0220">BSH.Common.Option.RemainingProgramTime</feature>
    <feature refUID="021E">BSH.Common.Option.ProgramProgress</feature>
    <feature refUID="0231">BSH.Common.Option.EnergyForecast</feature>
    <feature refUID="0232">BSH.Common.Option.WaterForecast</feature>
    <feature refUID="0233">BSH.Common.Option.EnergyConsumption</feature>
    <feature refUID="0234">BSH.Common.Option.WaterConsumption</feature>
    <feature refUID="4101">Dishcare.Dishwasher.Option.ExtraDry</feature>
    <feature refUID="4102">Dishcare.Dishwasher.Option.HalfLoad</feature>
    <feature refUID="4103">Dishcare.Dishwasher.Option.HygienePlus</feature>
    <feature refUID="4104">Dishcare.Dishwasher.Option.IntensivZone</feature>
    <feature refUID="4010">Dishcare.Dishwasher.Program.Eco50</feature>
    <feature refUID="4011">Dishcare.Dishwasher.Program.Auto2</feature>
    <feature refUID="4012">Dishcare.Dishwasher.Program.Quick45</feature>
    <feature refUID="0100">BSH.Common.Root.ActiveProgram</feature>
    <feature refUID="0101">BSH.Common.Root.SelectedProgram</feature>
  </featureDescription>
  <errorDescription/>
  <enumDescriptionList>
    <enumDescription refENID="2009" enumKey="BSH.Common.EnumType.Unused"/>
    <enumDescription refENID="200A" enumKey="BSH.Common.EnumType.OperationState">
      <enumMember refValue="0">Inactive</enumMember>
      <enumMember refValue="1">Ready</enumMember>
      <enumMember refValue="2">DelayedStart</enumMember>
      <enumMember refValue="3">Run</enumMember>
      <enumMember refValue="4">Pause</enumMember>
      <enumMember refValue="5">ActionRequired</enumMember>
      <enumMember refValue="6">Finished</enumMember>
      <enumMember refValue="7">Error</enumMember>
      <enumMember refValue="8">Aborting</enumMember>
    </enumDescription>
    <enumDescription refENID="200B" enumKey="Dishcare.Dishwasher.EnumType.ProgramPhase">
      <enumMember refValue="0">Pre-Wash</enumMember>
      <enumMember refValue="1">Main-Wash</enumMember>
      <enumMember refValue="2">Rinse</enumMember>
      <enumMember refValue="3">Dry</enumMember>
    </enumDescription>
    <enumDescription refENID="200C" enumKey="BSH.Common.EnumType.PowerState">
      <enumMember refValue="1">Off</enumMember>
      <enumMember refValue="2">On</enumMember>
      <enumMember refValue="3">Standby</enumMember>
    </enumDescription>
    <enumDescription refENID="200D" enumKey="BSH.Common.EnumType.EventPresentState">
      <enumMember refValue="0">Off</enumMember>
      <enumMember refValue="1">Present</enumMember>
      <enumMember refValue="2">Confirmed</enumMember>
    </enumDescription>
  </enumDescriptionList>
</featureMappingFile>`

export const DISHWASHER_IDDF_FILES: Readonly<Record<string, string>> = {
  'SMV4HCX48E_DeviceDescription.xml': DISHWASHER_DEVICE_DESCRIPTION_XML,
  'SMV4HCX48E_FeatureMapping.xml': DISHWASHER_FEATURE_MAPPING_XML,
}

/** Uids of this fixture, by feature name — specs push values by uid like the appliance does. */
export const FX = {
  backendConnected: 0x0005,
  remoteStartAllowed: 0x0205,
  remoteControlActive: 0x020b,
  doorState: 0x020f,
  operationState: 0x0228,
  localControlActive: 0x0210,
  programPhase: 0x0230,
  powerState: 0x021b,
  childLock: 0x0204,
  brightness: 0x0240,
  programFinished: 0x0310,
  saltNearlyEmpty: 0x0311,
  rinseAidNearlyEmpty: 0x0312,
  programAborted: 0x0313,
  pauseCmd: 0x0320,
  resumeCmd: 0x0321,
  abortCmd: 0x0322,
  startInRelative: 0x022e,
  remainingProgramTime: 0x0220,
  programProgress: 0x021e,
  energyForecast: 0x0231,
  waterForecast: 0x0232,
  energyConsumption: 0x0233,
  waterConsumption: 0x0234,
  extraDry: 0x4101,
  halfLoad: 0x4102,
  hygienePlus: 0x4103,
  intensivZone: 0x4104,
  progEco50: 0x4010,
  progAuto2: 0x4011,
  progQuick45: 0x4012,
  activeProgram: 0x0100,
  selectedProgram: 0x0101,
  unmappedStatus: 0x0999,
  unmappedSetting: 0x0998,
} as const

export const HA_ID = 'BOSCH-DW-1'

/** The fixture IDDF as the plain JSON the addon stores on the appliance. */
export function dishwasherCompactJson(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(
      parseHomeConnectIddfXml({
        deviceDescriptionXml: DISHWASHER_DEVICE_DESCRIPTION_XML,
        featureMappingXml: DISHWASHER_FEATURE_MAPPING_XML,
        haId: HA_ID,
      }),
    ),
  )
}

/** A fresh live description store over the fixture IDDF. */
export function dishwasherDescription(): HomeConnectDescriptionStore {
  return new HomeConnectDescriptionStore(dishwasherCompactJson())
}
