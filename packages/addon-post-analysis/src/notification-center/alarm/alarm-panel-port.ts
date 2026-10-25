/**
 * The camstack panel device, as the Notification Center sees it.
 *
 * One adapter, used by the addon's wiring and by every spec that drives the
 * real device through the real centre — so a method added to the port is
 * wired in ONE place, and a spec cannot quietly pass with a hand-written
 * adapter that forgot it.
 */

import type { NcAlarmPanelPort } from '../index.js'
import { NC_ALARM_MODES, type NcAlarmPanelDevice } from './alarm-panel-device.js'

export function ncAlarmPanelPort(panel: NcAlarmPanelDevice): NcAlarmPanelPort {
  return {
    deviceId: panel.id,
    settings: () => panel.settings(),
    applySettings: (patch) => panel.applySettings(patch),
    profilesView: () => panel.profilesView(),
    createProfile: (input) => panel.createProfile(input),
    renameProfile: (id, name) => panel.renameProfile(id, name),
    deleteProfile: (id) => panel.deleteProfile(id),
    activateProfile: (id) => panel.activateProfile(id),
    availableModes: () => NC_ALARM_MODES,
    triggerFromRule: (source) => panel.triggerFromRule(source),
    classifyRuleMatch: (source) => panel.classifyRuleMatch(source),
    announceLifted: (deviceId, now) => panel.announceLifted(deviceId, now),
    excludedDevices: () => panel.excludedDevices(),
    exclusionPhases: () => panel.exclusionPhases(),
    forgetExcluded: (deviceId) => panel.forgetExcluded(deviceId),
    bypassInput: (input) => panel.bypassInput(input),
    inputBypasses: () => panel.inputBypasses(),
    pruneInputBypasses: (keep) => panel.pruneInputBypasses(keep),
    currentState: () => panel.currentState(),
    currentTarget: () => panel.currentTarget(),
    armWith: (mode) => panel.armWith(mode),
    armAnyway: (refusalId) => panel.armAnyway(refusalId),
    disarm: () => panel.disarm(),
    observeOpening: (deviceId, reading, now, options) =>
      panel.observeOpening(deviceId, reading, now, options),
  }
}
