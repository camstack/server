// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-system-hooks.ts
/* eslint-disable */

/**
 * Per-method React-Query hooks for every `scope: 'system'` capability.
 *
 * Each hook is a thin pass-through to `trpc.<cap>.<method>.useQuery` /
 * `.useMutation` / `.useSubscription` so the typed inference + RQ
 * cache/dedup keep working — the generator only contributes a consistent
 * name and stable export surface so admin-ui pages can write
 * `useAddonsList()` instead of `trpc.addons.list.useQuery()`.
 *
 * Push-subscription methods (`kind: 'subscription'`) emit a typeof
 * alias over `useSubscription`, so the call shape is
 * `useToastOnToast(input, { onData: cb })` — same as the underlying
 * tRPC hook. The eventBus-backed `useLiveEvent` (see
 * `../hooks/use-live-event.ts`) covers events that don't ride a tRPC
 * subscription; the two surfaces coexist by design.
 */
import { trpc } from '../trpc-react.js'

/** Generated alias around `trpc.accessories.setChildHidden.useMutation`. */
export const useAccessoriesSetChildHidden: typeof trpc.accessories.setChildHidden.useMutation = trpc.accessories.setChildHidden.useMutation

/** Generated alias around `trpc.accessories.getStatus.useQuery`. */
export const useAccessoriesGetStatus: typeof trpc.accessories.getStatus.useQuery = trpc.accessories.getStatus.useQuery

/** Generated alias around `trpc.addonPages.listPages.useQuery`. */
export const useAddonPagesListPages: typeof trpc.addonPages.listPages.useQuery = trpc.addonPages.listPages.useQuery

/** Generated alias around `trpc.addons.list.useQuery`. */
export const useAddonsList: typeof trpc.addons.list.useQuery = trpc.addons.list.useQuery

/** Generated alias around `trpc.addons.getLogs.useQuery`. */
export const useAddonsGetLogs: typeof trpc.addons.getLogs.useQuery = trpc.addons.getLogs.useQuery

/** Generated alias around `trpc.addons.listPackages.useQuery`. */
export const useAddonsListPackages: typeof trpc.addons.listPackages.useQuery = trpc.addons.listPackages.useQuery

/** Generated alias around `trpc.addons.installPackage.useMutation`. */
export const useAddonsInstallPackage: typeof trpc.addons.installPackage.useMutation = trpc.addons.installPackage.useMutation

/** Generated alias around `trpc.addons.installFromWorkspace.useMutation`. */
export const useAddonsInstallFromWorkspace: typeof trpc.addons.installFromWorkspace.useMutation = trpc.addons.installFromWorkspace.useMutation

/** Generated alias around `trpc.addons.isWorkspaceAvailable.useQuery`. */
export const useAddonsIsWorkspaceAvailable: typeof trpc.addons.isWorkspaceAvailable.useQuery = trpc.addons.isWorkspaceAvailable.useQuery

/** Generated alias around `trpc.addons.listWorkspacePackages.useQuery`. */
export const useAddonsListWorkspacePackages: typeof trpc.addons.listWorkspacePackages.useQuery = trpc.addons.listWorkspacePackages.useQuery

/** Generated alias around `trpc.addons.uninstallPackage.useMutation`. */
export const useAddonsUninstallPackage: typeof trpc.addons.uninstallPackage.useMutation = trpc.addons.uninstallPackage.useMutation

/** Generated alias around `trpc.addons.listInstallations.useQuery`. */
export const useAddonsListInstallations: typeof trpc.addons.listInstallations.useQuery = trpc.addons.listInstallations.useQuery

/** Generated alias around `trpc.addons.reloadPackages.useMutation`. */
export const useAddonsReloadPackages: typeof trpc.addons.reloadPackages.useMutation = trpc.addons.reloadPackages.useMutation

/** Generated alias around `trpc.addons.searchAvailable.useQuery`. */
export const useAddonsSearchAvailable: typeof trpc.addons.searchAvailable.useQuery = trpc.addons.searchAvailable.useQuery

/** Generated alias around `trpc.addons.listUpdates.useQuery`. */
export const useAddonsListUpdates: typeof trpc.addons.listUpdates.useQuery = trpc.addons.listUpdates.useQuery

/** Generated alias around `trpc.addons.updatePackage.useMutation`. */
export const useAddonsUpdatePackage: typeof trpc.addons.updatePackage.useMutation = trpc.addons.updatePackage.useMutation

/** Generated alias around `trpc.addons.rollbackPackage.useMutation`. */
export const useAddonsRollbackPackage: typeof trpc.addons.rollbackPackage.useMutation = trpc.addons.rollbackPackage.useMutation

/** Generated alias around `trpc.addons.forceRefresh.useMutation`. */
export const useAddonsForceRefresh: typeof trpc.addons.forceRefresh.useMutation = trpc.addons.forceRefresh.useMutation

/** Generated alias around `trpc.addons.restartServer.useMutation`. */
export const useAddonsRestartServer: typeof trpc.addons.restartServer.useMutation = trpc.addons.restartServer.useMutation

/** Generated alias around `trpc.addons.getLastRestart.useQuery`. */
export const useAddonsGetLastRestart: typeof trpc.addons.getLastRestart.useQuery = trpc.addons.getLastRestart.useQuery

/** Generated alias around `trpc.addons.listFrameworkPackages.useQuery`. */
export const useAddonsListFrameworkPackages: typeof trpc.addons.listFrameworkPackages.useQuery = trpc.addons.listFrameworkPackages.useQuery

/** Generated alias around `trpc.addons.listCapabilityProviders.useQuery`. */
export const useAddonsListCapabilityProviders: typeof trpc.addons.listCapabilityProviders.useQuery = trpc.addons.listCapabilityProviders.useQuery

/** Generated alias around `trpc.addons.setCapabilityProviderEnabled.useMutation`. */
export const useAddonsSetCapabilityProviderEnabled: typeof trpc.addons.setCapabilityProviderEnabled.useMutation = trpc.addons.setCapabilityProviderEnabled.useMutation

/** Generated alias around `trpc.addons.getVersions.useQuery`. */
export const useAddonsGetVersions: typeof trpc.addons.getVersions.useQuery = trpc.addons.getVersions.useQuery

/** Generated alias around `trpc.addons.getPackageDocs.useQuery`. */
export const useAddonsGetPackageDocs: typeof trpc.addons.getPackageDocs.useQuery = trpc.addons.getPackageDocs.useQuery

/** Generated alias around `trpc.addons.restartAddon.useMutation`. */
export const useAddonsRestartAddon: typeof trpc.addons.restartAddon.useMutation = trpc.addons.restartAddon.useMutation

/** Generated alias around `trpc.addons.retryLoad.useMutation`. */
export const useAddonsRetryLoad: typeof trpc.addons.retryLoad.useMutation = trpc.addons.retryLoad.useMutation

/** Generated alias around `trpc.addons.getAutoUpdateSettings.useQuery`. */
export const useAddonsGetAutoUpdateSettings: typeof trpc.addons.getAutoUpdateSettings.useQuery = trpc.addons.getAutoUpdateSettings.useQuery

/** Generated alias around `trpc.addons.setAutoUpdateSettings.useMutation`. */
export const useAddonsSetAutoUpdateSettings: typeof trpc.addons.setAutoUpdateSettings.useMutation = trpc.addons.setAutoUpdateSettings.useMutation

/** Generated alias around `trpc.addons.getAddonAutoUpdate.useQuery`. */
export const useAddonsGetAddonAutoUpdate: typeof trpc.addons.getAddonAutoUpdate.useQuery = trpc.addons.getAddonAutoUpdate.useQuery

/** Generated alias around `trpc.addons.setAddonAutoUpdate.useMutation`. */
export const useAddonsSetAddonAutoUpdate: typeof trpc.addons.setAddonAutoUpdate.useMutation = trpc.addons.setAddonAutoUpdate.useMutation

/** Generated alias around `trpc.addons.applyAutoUpdateToAll.useMutation`. */
export const useAddonsApplyAutoUpdateToAll: typeof trpc.addons.applyAutoUpdateToAll.useMutation = trpc.addons.applyAutoUpdateToAll.useMutation

/** Generated alias around `trpc.addons.custom.useMutation`. */
export const useAddonsCustom: typeof trpc.addons.custom.useMutation = trpc.addons.custom.useMutation

/** Generated alias around `trpc.addons.startJob.useMutation`. */
export const useAddonsStartJob: typeof trpc.addons.startJob.useMutation = trpc.addons.startJob.useMutation

/** Generated alias around `trpc.addons.getJob.useQuery`. */
export const useAddonsGetJob: typeof trpc.addons.getJob.useQuery = trpc.addons.getJob.useQuery

/** Generated alias around `trpc.addons.listJobs.useQuery`. */
export const useAddonsListJobs: typeof trpc.addons.listJobs.useQuery = trpc.addons.listJobs.useQuery

/** Generated alias around `trpc.addons.cancelJob.useMutation`. */
export const useAddonsCancelJob: typeof trpc.addons.cancelJob.useMutation = trpc.addons.cancelJob.useMutation

/** Generated alias around `trpc.addons.onAddonLogs.useSubscription`. */
export const useAddonsOnAddonLogs: typeof trpc.addons.onAddonLogs.useSubscription = trpc.addons.onAddonLogs.useSubscription

/** Generated alias around `trpc.addonSettings.getGlobalSettings.useQuery`. */
export const useAddonSettingsGetGlobalSettings: typeof trpc.addonSettings.getGlobalSettings.useQuery = trpc.addonSettings.getGlobalSettings.useQuery

/** Generated alias around `trpc.addonSettings.updateGlobalSettings.useMutation`. */
export const useAddonSettingsUpdateGlobalSettings: typeof trpc.addonSettings.updateGlobalSettings.useMutation = trpc.addonSettings.updateGlobalSettings.useMutation

/** Generated alias around `trpc.addonSettings.getIntegrationSettings.useQuery`. */
export const useAddonSettingsGetIntegrationSettings: typeof trpc.addonSettings.getIntegrationSettings.useQuery = trpc.addonSettings.getIntegrationSettings.useQuery

/** Generated alias around `trpc.addonSettings.getDeviceSettings.useQuery`. */
export const useAddonSettingsGetDeviceSettings: typeof trpc.addonSettings.getDeviceSettings.useQuery = trpc.addonSettings.getDeviceSettings.useQuery

/** Generated alias around `trpc.addonSettings.updateDeviceSettings.useMutation`. */
export const useAddonSettingsUpdateDeviceSettings: typeof trpc.addonSettings.updateDeviceSettings.useMutation = trpc.addonSettings.updateDeviceSettings.useMutation

/** Generated alias around `trpc.addonWidgets.listWidgets.useQuery`. */
export const useAddonWidgetsListWidgets: typeof trpc.addonWidgets.listWidgets.useQuery = trpc.addonWidgets.listWidgets.useQuery

/** Generated alias around `trpc.airQualitySensor.getStatus.useQuery`. */
export const useAirQualitySensorGetStatus: typeof trpc.airQualitySensor.getStatus.useQuery = trpc.airQualitySensor.getStatus.useQuery

/** Generated alias around `trpc.alarmPanel.arm.useMutation`. */
export const useAlarmPanelArm: typeof trpc.alarmPanel.arm.useMutation = trpc.alarmPanel.arm.useMutation

/** Generated alias around `trpc.alarmPanel.disarm.useMutation`. */
export const useAlarmPanelDisarm: typeof trpc.alarmPanel.disarm.useMutation = trpc.alarmPanel.disarm.useMutation

/** Generated alias around `trpc.alarmPanel.trigger.useMutation`. */
export const useAlarmPanelTrigger: typeof trpc.alarmPanel.trigger.useMutation = trpc.alarmPanel.trigger.useMutation

/** Generated alias around `trpc.alarmPanel.getStatus.useQuery`. */
export const useAlarmPanelGetStatus: typeof trpc.alarmPanel.getStatus.useQuery = trpc.alarmPanel.getStatus.useQuery

/** Generated alias around `trpc.alerts.emit.useMutation`. */
export const useAlertsEmit: typeof trpc.alerts.emit.useMutation = trpc.alerts.emit.useMutation

/** Generated alias around `trpc.alerts.update.useMutation`. */
export const useAlertsUpdate: typeof trpc.alerts.update.useMutation = trpc.alerts.update.useMutation

/** Generated alias around `trpc.alerts.list.useQuery`. */
export const useAlertsList: typeof trpc.alerts.list.useQuery = trpc.alerts.list.useQuery

/** Generated alias around `trpc.alerts.getUnreadCount.useQuery`. */
export const useAlertsGetUnreadCount: typeof trpc.alerts.getUnreadCount.useQuery = trpc.alerts.getUnreadCount.useQuery

/** Generated alias around `trpc.alerts.markRead.useMutation`. */
export const useAlertsMarkRead: typeof trpc.alerts.markRead.useMutation = trpc.alerts.markRead.useMutation

/** Generated alias around `trpc.alerts.markAllRead.useMutation`. */
export const useAlertsMarkAllRead: typeof trpc.alerts.markAllRead.useMutation = trpc.alerts.markAllRead.useMutation

/** Generated alias around `trpc.alerts.dismiss.useMutation`. */
export const useAlertsDismiss: typeof trpc.alerts.dismiss.useMutation = trpc.alerts.dismiss.useMutation

/** Generated alias around `trpc.ambientLightSensor.getStatus.useQuery`. */
export const useAmbientLightSensorGetStatus: typeof trpc.ambientLightSensor.getStatus.useQuery = trpc.ambientLightSensor.getStatus.useQuery

/** Generated alias around `trpc.audioAnalysis.resolveDeviceSettings.useQuery`. */
export const useAudioAnalysisResolveDeviceSettings: typeof trpc.audioAnalysis.resolveDeviceSettings.useQuery = trpc.audioAnalysis.resolveDeviceSettings.useQuery

/** Generated alias around `trpc.audioAnalysis.getDeviceSettingsContribution.useQuery`. */
export const useAudioAnalysisGetDeviceSettingsContribution: typeof trpc.audioAnalysis.getDeviceSettingsContribution.useQuery = trpc.audioAnalysis.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.audioAnalysis.getDeviceLiveContribution.useQuery`. */
export const useAudioAnalysisGetDeviceLiveContribution: typeof trpc.audioAnalysis.getDeviceLiveContribution.useQuery = trpc.audioAnalysis.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.audioAnalysis.applyDeviceSettingsPatch.useMutation`. */
export const useAudioAnalysisApplyDeviceSettingsPatch: typeof trpc.audioAnalysis.applyDeviceSettingsPatch.useMutation = trpc.audioAnalysis.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.audioAnalyzer.analyseChunk.useMutation`. */
export const useAudioAnalyzerAnalyseChunk: typeof trpc.audioAnalyzer.analyseChunk.useMutation = trpc.audioAnalyzer.analyseChunk.useMutation

/** Generated alias around `trpc.audioAnalyzer.classify.useQuery`. */
export const useAudioAnalyzerClassify: typeof trpc.audioAnalyzer.classify.useQuery = trpc.audioAnalyzer.classify.useQuery

/** Generated alias around `trpc.audioAnalyzer.attachDevice.useMutation`. */
export const useAudioAnalyzerAttachDevice: typeof trpc.audioAnalyzer.attachDevice.useMutation = trpc.audioAnalyzer.attachDevice.useMutation

/** Generated alias around `trpc.audioAnalyzer.detachDevice.useMutation`. */
export const useAudioAnalyzerDetachDevice: typeof trpc.audioAnalyzer.detachDevice.useMutation = trpc.audioAnalyzer.detachDevice.useMutation

/** Generated alias around `trpc.audioAnalyzer.isReady.useQuery`. */
export const useAudioAnalyzerIsReady: typeof trpc.audioAnalyzer.isReady.useQuery = trpc.audioAnalyzer.isReady.useQuery

/** Generated alias around `trpc.audioAnalyzer.dispose.useMutation`. */
export const useAudioAnalyzerDispose: typeof trpc.audioAnalyzer.dispose.useMutation = trpc.audioAnalyzer.dispose.useMutation

/** Generated alias around `trpc.audioAnalyzer.reprobeAudioEngine.useMutation`. */
export const useAudioAnalyzerReprobeAudioEngine: typeof trpc.audioAnalyzer.reprobeAudioEngine.useMutation = trpc.audioAnalyzer.reprobeAudioEngine.useMutation

/** Generated alias around `trpc.audioCodec.listSupportedCodecs.useQuery`. */
export const useAudioCodecListSupportedCodecs: typeof trpc.audioCodec.listSupportedCodecs.useQuery = trpc.audioCodec.listSupportedCodecs.useQuery

/** Generated alias around `trpc.audioCodec.canHandle.useQuery`. */
export const useAudioCodecCanHandle: typeof trpc.audioCodec.canHandle.useQuery = trpc.audioCodec.canHandle.useQuery

/** Generated alias around `trpc.audioCodec.createDecodeSession.useMutation`. */
export const useAudioCodecCreateDecodeSession: typeof trpc.audioCodec.createDecodeSession.useMutation = trpc.audioCodec.createDecodeSession.useMutation

/** Generated alias around `trpc.audioCodec.createEncodeSession.useMutation`. */
export const useAudioCodecCreateEncodeSession: typeof trpc.audioCodec.createEncodeSession.useMutation = trpc.audioCodec.createEncodeSession.useMutation

/** Generated alias around `trpc.audioCodec.closeSession.useMutation`. */
export const useAudioCodecCloseSession: typeof trpc.audioCodec.closeSession.useMutation = trpc.audioCodec.closeSession.useMutation

/** Generated alias around `trpc.audioCodec.pushEncodedFrame.useMutation`. */
export const useAudioCodecPushEncodedFrame: typeof trpc.audioCodec.pushEncodedFrame.useMutation = trpc.audioCodec.pushEncodedFrame.useMutation

/** Generated alias around `trpc.audioCodec.pullPcm.useQuery`. */
export const useAudioCodecPullPcm: typeof trpc.audioCodec.pullPcm.useQuery = trpc.audioCodec.pullPcm.useQuery

/** Generated alias around `trpc.audioCodec.pushPcm.useMutation`. */
export const useAudioCodecPushPcm: typeof trpc.audioCodec.pushPcm.useMutation = trpc.audioCodec.pushPcm.useMutation

/** Generated alias around `trpc.audioCodec.pullEncoded.useQuery`. */
export const useAudioCodecPullEncoded: typeof trpc.audioCodec.pullEncoded.useQuery = trpc.audioCodec.pullEncoded.useQuery

/** Generated alias around `trpc.audioCodec.flushEncode.useMutation`. */
export const useAudioCodecFlushEncode: typeof trpc.audioCodec.flushEncode.useMutation = trpc.audioCodec.flushEncode.useMutation

/** Generated alias around `trpc.audioCodec.listActiveSessions.useQuery`. */
export const useAudioCodecListActiveSessions: typeof trpc.audioCodec.listActiveSessions.useQuery = trpc.audioCodec.listActiveSessions.useQuery

/** Generated alias around `trpc.audioMetrics.getCurrentSnapshot.useQuery`. */
export const useAudioMetricsGetCurrentSnapshot: typeof trpc.audioMetrics.getCurrentSnapshot.useQuery = trpc.audioMetrics.getCurrentSnapshot.useQuery

/** Generated alias around `trpc.audioMetrics.getHistory.useQuery`. */
export const useAudioMetricsGetHistory: typeof trpc.audioMetrics.getHistory.useQuery = trpc.audioMetrics.getHistory.useQuery

/** Generated alias around `trpc.automationControl.enable.useMutation`. */
export const useAutomationControlEnable: typeof trpc.automationControl.enable.useMutation = trpc.automationControl.enable.useMutation

/** Generated alias around `trpc.automationControl.disable.useMutation`. */
export const useAutomationControlDisable: typeof trpc.automationControl.disable.useMutation = trpc.automationControl.disable.useMutation

/** Generated alias around `trpc.automationControl.trigger.useMutation`. */
export const useAutomationControlTrigger: typeof trpc.automationControl.trigger.useMutation = trpc.automationControl.trigger.useMutation

/** Generated alias around `trpc.automationControl.getStatus.useQuery`. */
export const useAutomationControlGetStatus: typeof trpc.automationControl.getStatus.useQuery = trpc.automationControl.getStatus.useQuery

/** Generated alias around `trpc.backup.listDestinations.useQuery`. */
export const useBackupListDestinations: typeof trpc.backup.listDestinations.useQuery = trpc.backup.listDestinations.useQuery

/** Generated alias around `trpc.backup.trigger.useMutation`. */
export const useBackupTrigger: typeof trpc.backup.trigger.useMutation = trpc.backup.trigger.useMutation

/** Generated alias around `trpc.backup.listRuns.useQuery`. */
export const useBackupListRuns: typeof trpc.backup.listRuns.useQuery = trpc.backup.listRuns.useQuery

/** Generated alias around `trpc.backup.cancel.useMutation`. */
export const useBackupCancel: typeof trpc.backup.cancel.useMutation = trpc.backup.cancel.useMutation

/** Generated alias around `trpc.backup.list.useQuery`. */
export const useBackupList: typeof trpc.backup.list.useQuery = trpc.backup.list.useQuery

/** Generated alias around `trpc.backup.listLocations.useQuery`. */
export const useBackupListLocations: typeof trpc.backup.listLocations.useQuery = trpc.backup.listLocations.useQuery

/** Generated alias around `trpc.backup.getEntries.useQuery`. */
export const useBackupGetEntries: typeof trpc.backup.getEntries.useQuery = trpc.backup.getEntries.useQuery

/** Generated alias around `trpc.backup.restore.useMutation`. */
export const useBackupRestore: typeof trpc.backup.restore.useMutation = trpc.backup.restore.useMutation

/** Generated alias around `trpc.backup.getEncryption.useQuery`. */
export const useBackupGetEncryption: typeof trpc.backup.getEncryption.useQuery = trpc.backup.getEncryption.useQuery

/** Generated alias around `trpc.backup.setupEncryption.useMutation`. */
export const useBackupSetupEncryption: typeof trpc.backup.setupEncryption.useMutation = trpc.backup.setupEncryption.useMutation

/** Generated alias around `trpc.backup.disableEncryption.useMutation`. */
export const useBackupDisableEncryption: typeof trpc.backup.disableEncryption.useMutation = trpc.backup.disableEncryption.useMutation

/** Generated alias around `trpc.backup.checkBackupKey.useMutation`. */
export const useBackupCheckBackupKey: typeof trpc.backup.checkBackupKey.useMutation = trpc.backup.checkBackupKey.useMutation

/** Generated alias around `trpc.backup.delete.useMutation`. */
export const useBackupDelete: typeof trpc.backup.delete.useMutation = trpc.backup.delete.useMutation

/** Generated alias around `trpc.backup.listArchives.useQuery`. */
export const useBackupListArchives: typeof trpc.backup.listArchives.useQuery = trpc.backup.listArchives.useQuery

/** Generated alias around `trpc.backup.upsertDestinationPolicy.useMutation`. */
export const useBackupUpsertDestinationPolicy: typeof trpc.backup.upsertDestinationPolicy.useMutation = trpc.backup.upsertDestinationPolicy.useMutation

/** Generated alias around `trpc.backup.previewSchedule.useQuery`. */
export const useBackupPreviewSchedule: typeof trpc.backup.previewSchedule.useQuery = trpc.backup.previewSchedule.useQuery

/** Generated alias around `trpc.backup.listSchedules.useQuery`. */
export const useBackupListSchedules: typeof trpc.backup.listSchedules.useQuery = trpc.backup.listSchedules.useQuery

/** Generated alias around `trpc.backup.listAvailableDatabases.useQuery`. */
export const useBackupListAvailableDatabases: typeof trpc.backup.listAvailableDatabases.useQuery = trpc.backup.listAvailableDatabases.useQuery

/** Generated alias around `trpc.backup.upsertSchedule.useMutation`. */
export const useBackupUpsertSchedule: typeof trpc.backup.upsertSchedule.useMutation = trpc.backup.upsertSchedule.useMutation

/** Generated alias around `trpc.backup.deleteSchedule.useMutation`. */
export const useBackupDeleteSchedule: typeof trpc.backup.deleteSchedule.useMutation = trpc.backup.deleteSchedule.useMutation

/** Generated alias around `trpc.battery.wakeForStream.useMutation`. */
export const useBatteryWakeForStream: typeof trpc.battery.wakeForStream.useMutation = trpc.battery.wakeForStream.useMutation

/** Generated alias around `trpc.battery.getStatus.useQuery`. */
export const useBatteryGetStatus: typeof trpc.battery.getStatus.useQuery = trpc.battery.getStatus.useQuery

/** Generated alias around `trpc.binary.getStatus.useQuery`. */
export const useBinaryGetStatus: typeof trpc.binary.getStatus.useQuery = trpc.binary.getStatus.useQuery

/** Generated alias around `trpc.brightness.setBrightness.useMutation`. */
export const useBrightnessSetBrightness: typeof trpc.brightness.setBrightness.useMutation = trpc.brightness.setBrightness.useMutation

/** Generated alias around `trpc.brightness.getStatus.useQuery`. */
export const useBrightnessGetStatus: typeof trpc.brightness.getStatus.useQuery = trpc.brightness.getStatus.useQuery

/** Generated alias around `trpc.broker.list.useQuery`. */
export const useBrokerList: typeof trpc.broker.list.useQuery = trpc.broker.list.useQuery

/** Generated alias around `trpc.broker.get.useQuery`. */
export const useBrokerGet: typeof trpc.broker.get.useQuery = trpc.broker.get.useQuery

/** Generated alias around `trpc.broker.listProviders.useQuery`. */
export const useBrokerListProviders: typeof trpc.broker.listProviders.useQuery = trpc.broker.listProviders.useQuery

/** Generated alias around `trpc.broker.add.useMutation`. */
export const useBrokerAdd: typeof trpc.broker.add.useMutation = trpc.broker.add.useMutation

/** Generated alias around `trpc.broker.remove.useMutation`. */
export const useBrokerRemove: typeof trpc.broker.remove.useMutation = trpc.broker.remove.useMutation

/** Generated alias around `trpc.broker.testConnection.useMutation`. */
export const useBrokerTestConnection: typeof trpc.broker.testConnection.useMutation = trpc.broker.testConnection.useMutation

/** Generated alias around `trpc.broker.getSettings.useQuery`. */
export const useBrokerGetSettings: typeof trpc.broker.getSettings.useQuery = trpc.broker.getSettings.useQuery

/** Generated alias around `trpc.broker.setSettings.useMutation`. */
export const useBrokerSetSettings: typeof trpc.broker.setSettings.useMutation = trpc.broker.setSettings.useMutation

/** Generated alias around `trpc.broker.getBrokerConfig.useQuery`. */
export const useBrokerGetBrokerConfig: typeof trpc.broker.getBrokerConfig.useQuery = trpc.broker.getBrokerConfig.useQuery

/** Generated alias around `trpc.broker.getSettingsSchema.useQuery`. */
export const useBrokerGetSettingsSchema: typeof trpc.broker.getSettingsSchema.useQuery = trpc.broker.getSettingsSchema.useQuery

/** Generated alias around `trpc.broker.testSettings.useMutation`. */
export const useBrokerTestSettings: typeof trpc.broker.testSettings.useMutation = trpc.broker.testSettings.useMutation

/** Generated alias around `trpc.broker.publish.useMutation`. */
export const useBrokerPublish: typeof trpc.broker.publish.useMutation = trpc.broker.publish.useMutation

/** Generated alias around `trpc.broker.subscribe.useMutation`. */
export const useBrokerSubscribe: typeof trpc.broker.subscribe.useMutation = trpc.broker.subscribe.useMutation

/** Generated alias around `trpc.broker.unsubscribe.useMutation`. */
export const useBrokerUnsubscribe: typeof trpc.broker.unsubscribe.useMutation = trpc.broker.unsubscribe.useMutation

/** Generated alias around `trpc.broker.getState.useQuery`. */
export const useBrokerGetState: typeof trpc.broker.getState.useQuery = trpc.broker.getState.useQuery

/** Generated alias around `trpc.broker.getStatus.useQuery`. */
export const useBrokerGetStatus: typeof trpc.broker.getStatus.useQuery = trpc.broker.getStatus.useQuery

/** Generated alias around `trpc.button.press.useMutation`. */
export const useButtonPress: typeof trpc.button.press.useMutation = trpc.button.press.useMutation

/** Generated alias around `trpc.calendars.listCalendars.useQuery`. */
export const useCalendarsListCalendars: typeof trpc.calendars.listCalendars.useQuery = trpc.calendars.listCalendars.useQuery

/** Generated alias around `trpc.calendars.listEvents.useQuery`. */
export const useCalendarsListEvents: typeof trpc.calendars.listEvents.useQuery = trpc.calendars.listEvents.useQuery

/** Generated alias around `trpc.calendars.getPreferences.useQuery`. */
export const useCalendarsGetPreferences: typeof trpc.calendars.getPreferences.useQuery = trpc.calendars.getPreferences.useQuery

/** Generated alias around `trpc.calendars.setCalendarPreference.useMutation`. */
export const useCalendarsSetCalendarPreference: typeof trpc.calendars.setCalendarPreference.useMutation = trpc.calendars.setCalendarPreference.useMutation

/** Generated alias around `trpc.cameraCredentials.getCredentials.useQuery`. */
export const useCameraCredentialsGetCredentials: typeof trpc.cameraCredentials.getCredentials.useQuery = trpc.cameraCredentials.getCredentials.useQuery

/** Generated alias around `trpc.cameraCredentials.getStatus.useQuery`. */
export const useCameraCredentialsGetStatus: typeof trpc.cameraCredentials.getStatus.useQuery = trpc.cameraCredentials.getStatus.useQuery

/** Generated alias around `trpc.cameraGridLayout.getLayout.useQuery`. */
export const useCameraGridLayoutGetLayout: typeof trpc.cameraGridLayout.getLayout.useQuery = trpc.cameraGridLayout.getLayout.useQuery

/** Generated alias around `trpc.cameraGridLayout.saveLayout.useMutation`. */
export const useCameraGridLayoutSaveLayout: typeof trpc.cameraGridLayout.saveLayout.useMutation = trpc.cameraGridLayout.saveLayout.useMutation

/** Generated alias around `trpc.cameraGridLayout.getDeviceSettingsContribution.useQuery`. */
export const useCameraGridLayoutGetDeviceSettingsContribution: typeof trpc.cameraGridLayout.getDeviceSettingsContribution.useQuery = trpc.cameraGridLayout.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.cameraGridLayout.getDeviceLiveContribution.useQuery`. */
export const useCameraGridLayoutGetDeviceLiveContribution: typeof trpc.cameraGridLayout.getDeviceLiveContribution.useQuery = trpc.cameraGridLayout.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.cameraGridLayout.applyDeviceSettingsPatch.useMutation`. */
export const useCameraGridLayoutApplyDeviceSettingsPatch: typeof trpc.cameraGridLayout.applyDeviceSettingsPatch.useMutation = trpc.cameraGridLayout.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.cameraPipelineConfig.getDeviceSettingsContribution.useQuery`. */
export const useCameraPipelineConfigGetDeviceSettingsContribution: typeof trpc.cameraPipelineConfig.getDeviceSettingsContribution.useQuery = trpc.cameraPipelineConfig.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.cameraPipelineConfig.getDeviceLiveContribution.useQuery`. */
export const useCameraPipelineConfigGetDeviceLiveContribution: typeof trpc.cameraPipelineConfig.getDeviceLiveContribution.useQuery = trpc.cameraPipelineConfig.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.cameraPipelineConfig.applyDeviceSettingsPatch.useMutation`. */
export const useCameraPipelineConfigApplyDeviceSettingsPatch: typeof trpc.cameraPipelineConfig.applyDeviceSettingsPatch.useMutation = trpc.cameraPipelineConfig.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.cameraStreams.getCameraStreams.useQuery`. */
export const useCameraStreamsGetCameraStreams: typeof trpc.cameraStreams.getCameraStreams.useQuery = trpc.cameraStreams.getCameraStreams.useQuery

/** Generated alias around `trpc.cameraStreams.getBrokerStreams.useQuery`. */
export const useCameraStreamsGetBrokerStreams: typeof trpc.cameraStreams.getBrokerStreams.useQuery = trpc.cameraStreams.getBrokerStreams.useQuery

/** Generated alias around `trpc.cameraStreams.getRtspEntries.useQuery`. */
export const useCameraStreamsGetRtspEntries: typeof trpc.cameraStreams.getRtspEntries.useQuery = trpc.cameraStreams.getRtspEntries.useQuery

/** Generated alias around `trpc.cameraStreams.getProfileRtspEntries.useQuery`. */
export const useCameraStreamsGetProfileRtspEntries: typeof trpc.cameraStreams.getProfileRtspEntries.useQuery = trpc.cameraStreams.getProfileRtspEntries.useQuery

/** Generated alias around `trpc.cameraStreams.pickStream.useQuery`. */
export const useCameraStreamsPickStream: typeof trpc.cameraStreams.pickStream.useQuery = trpc.cameraStreams.pickStream.useQuery

/** Generated alias around `trpc.carbonMonoxide.getStatus.useQuery`. */
export const useCarbonMonoxideGetStatus: typeof trpc.carbonMonoxide.getStatus.useQuery = trpc.carbonMonoxide.getStatus.useQuery

/** Generated alias around `trpc.climateControl.setMode.useMutation`. */
export const useClimateControlSetMode: typeof trpc.climateControl.setMode.useMutation = trpc.climateControl.setMode.useMutation

/** Generated alias around `trpc.climateControl.setFanMode.useMutation`. */
export const useClimateControlSetFanMode: typeof trpc.climateControl.setFanMode.useMutation = trpc.climateControl.setFanMode.useMutation

/** Generated alias around `trpc.climateControl.setPreset.useMutation`. */
export const useClimateControlSetPreset: typeof trpc.climateControl.setPreset.useMutation = trpc.climateControl.setPreset.useMutation

/** Generated alias around `trpc.climateControl.setTarget.useMutation`. */
export const useClimateControlSetTarget: typeof trpc.climateControl.setTarget.useMutation = trpc.climateControl.setTarget.useMutation

/** Generated alias around `trpc.climateControl.setTargetRange.useMutation`. */
export const useClimateControlSetTargetRange: typeof trpc.climateControl.setTargetRange.useMutation = trpc.climateControl.setTargetRange.useMutation

/** Generated alias around `trpc.climateControl.setTargetHumidity.useMutation`. */
export const useClimateControlSetTargetHumidity: typeof trpc.climateControl.setTargetHumidity.useMutation = trpc.climateControl.setTargetHumidity.useMutation

/** Generated alias around `trpc.climateControl.setSwingVertical.useMutation`. */
export const useClimateControlSetSwingVertical: typeof trpc.climateControl.setSwingVertical.useMutation = trpc.climateControl.setSwingVertical.useMutation

/** Generated alias around `trpc.climateControl.setSwingHorizontal.useMutation`. */
export const useClimateControlSetSwingHorizontal: typeof trpc.climateControl.setSwingHorizontal.useMutation = trpc.climateControl.setSwingHorizontal.useMutation

/** Generated alias around `trpc.climateControl.getStatus.useQuery`. */
export const useClimateControlGetStatus: typeof trpc.climateControl.getStatus.useQuery = trpc.climateControl.getStatus.useQuery

/** Generated alias around `trpc.color.setColor.useMutation`. */
export const useColorSetColor: typeof trpc.color.setColor.useMutation = trpc.color.setColor.useMutation

/** Generated alias around `trpc.color.getStatus.useQuery`. */
export const useColorGetStatus: typeof trpc.color.getStatus.useQuery = trpc.color.getStatus.useQuery

/** Generated alias around `trpc.connectionTest.testSettings.useMutation`. */
export const useConnectionTestTestSettings: typeof trpc.connectionTest.testSettings.useMutation = trpc.connectionTest.testSettings.useMutation

/** Generated alias around `trpc.connectionTest.describeTest.useQuery`. */
export const useConnectionTestDescribeTest: typeof trpc.connectionTest.describeTest.useQuery = trpc.connectionTest.describeTest.useQuery

/** Generated alias around `trpc.connectivity.getStatus.useQuery`. */
export const useConnectivityGetStatus: typeof trpc.connectivity.getStatus.useQuery = trpc.connectivity.getStatus.useQuery

/** Generated alias around `trpc.consumables.reset.useMutation`. */
export const useConsumablesReset: typeof trpc.consumables.reset.useMutation = trpc.consumables.reset.useMutation

/** Generated alias around `trpc.consumables.getStatus.useQuery`. */
export const useConsumablesGetStatus: typeof trpc.consumables.getStatus.useQuery = trpc.consumables.getStatus.useQuery

/** Generated alias around `trpc.contact.getStatus.useQuery`. */
export const useContactGetStatus: typeof trpc.contact.getStatus.useQuery = trpc.contact.getStatus.useQuery

/** Generated alias around `trpc.control.setValue.useMutation`. */
export const useControlSetValue: typeof trpc.control.setValue.useMutation = trpc.control.setValue.useMutation

/** Generated alias around `trpc.control.getStatus.useQuery`. */
export const useControlGetStatus: typeof trpc.control.getStatus.useQuery = trpc.control.getStatus.useQuery

/** Generated alias around `trpc.coreBlocks.list.useQuery`. */
export const useCoreBlocksList: typeof trpc.coreBlocks.list.useQuery = trpc.coreBlocks.list.useQuery

/** Generated alias around `trpc.coreBlocks.get.useQuery`. */
export const useCoreBlocksGet: typeof trpc.coreBlocks.get.useQuery = trpc.coreBlocks.get.useQuery

/** Generated alias around `trpc.coreBlocks.create.useMutation`. */
export const useCoreBlocksCreate: typeof trpc.coreBlocks.create.useMutation = trpc.coreBlocks.create.useMutation

/** Generated alias around `trpc.coreBlocks.update.useMutation`. */
export const useCoreBlocksUpdate: typeof trpc.coreBlocks.update.useMutation = trpc.coreBlocks.update.useMutation

/** Generated alias around `trpc.coreBlocks.delete.useMutation`. */
export const useCoreBlocksDelete: typeof trpc.coreBlocks.delete.useMutation = trpc.coreBlocks.delete.useMutation

/** Generated alias around `trpc.coreBlocks.setEnabled.useMutation`. */
export const useCoreBlocksSetEnabled: typeof trpc.coreBlocks.setEnabled.useMutation = trpc.coreBlocks.setEnabled.useMutation

/** Generated alias around `trpc.coreBlocks.restart.useMutation`. */
export const useCoreBlocksRestart: typeof trpc.coreBlocks.restart.useMutation = trpc.coreBlocks.restart.useMutation

/** Generated alias around `trpc.coreBlocks.compile.useMutation`. */
export const useCoreBlocksCompile: typeof trpc.coreBlocks.compile.useMutation = trpc.coreBlocks.compile.useMutation

/** Generated alias around `trpc.coreBlocks.getBlockSettings.useQuery`. */
export const useCoreBlocksGetBlockSettings: typeof trpc.coreBlocks.getBlockSettings.useQuery = trpc.coreBlocks.getBlockSettings.useQuery

/** Generated alias around `trpc.coreBlocks.updateBlockSettings.useMutation`. */
export const useCoreBlocksUpdateBlockSettings: typeof trpc.coreBlocks.updateBlockSettings.useMutation = trpc.coreBlocks.updateBlockSettings.useMutation

/** Generated alias around `trpc.coreBlocks.migrateRawSecrets.useMutation`. */
export const useCoreBlocksMigrateRawSecrets: typeof trpc.coreBlocks.migrateRawSecrets.useMutation = trpc.coreBlocks.migrateRawSecrets.useMutation

/** Generated alias around `trpc.coreBlocks.getTypeDefs.useQuery`. */
export const useCoreBlocksGetTypeDefs: typeof trpc.coreBlocks.getTypeDefs.useQuery = trpc.coreBlocks.getTypeDefs.useQuery

/** Generated alias around `trpc.coreBlocks.createComposition.useMutation`. */
export const useCoreBlocksCreateComposition: typeof trpc.coreBlocks.createComposition.useMutation = trpc.coreBlocks.createComposition.useMutation

/** Generated alias around `trpc.coreBlocks.updateComposition.useMutation`. */
export const useCoreBlocksUpdateComposition: typeof trpc.coreBlocks.updateComposition.useMutation = trpc.coreBlocks.updateComposition.useMutation

/** Generated alias around `trpc.coreBlocks.getComposition.useQuery`. */
export const useCoreBlocksGetComposition: typeof trpc.coreBlocks.getComposition.useQuery = trpc.coreBlocks.getComposition.useQuery

/** Generated alias around `trpc.coreBlocks.listCompositions.useQuery`. */
export const useCoreBlocksListCompositions: typeof trpc.coreBlocks.listCompositions.useQuery = trpc.coreBlocks.listCompositions.useQuery

/** Generated alias around `trpc.coreBlocks.getCustomization.useQuery`. */
export const useCoreBlocksGetCustomization: typeof trpc.coreBlocks.getCustomization.useQuery = trpc.coreBlocks.getCustomization.useQuery

/** Generated alias around `trpc.coreBlocks.listComposableCaps.useQuery`. */
export const useCoreBlocksListComposableCaps: typeof trpc.coreBlocks.listComposableCaps.useQuery = trpc.coreBlocks.listComposableCaps.useQuery

/** Generated alias around `trpc.coreBlocks.validateComposition.useMutation`. */
export const useCoreBlocksValidateComposition: typeof trpc.coreBlocks.validateComposition.useMutation = trpc.coreBlocks.validateComposition.useMutation

/** Generated alias around `trpc.cover.open.useMutation`. */
export const useCoverOpen: typeof trpc.cover.open.useMutation = trpc.cover.open.useMutation

/** Generated alias around `trpc.cover.close.useMutation`. */
export const useCoverClose: typeof trpc.cover.close.useMutation = trpc.cover.close.useMutation

/** Generated alias around `trpc.cover.stop.useMutation`. */
export const useCoverStop: typeof trpc.cover.stop.useMutation = trpc.cover.stop.useMutation

/** Generated alias around `trpc.cover.setPosition.useMutation`. */
export const useCoverSetPosition: typeof trpc.cover.setPosition.useMutation = trpc.cover.setPosition.useMutation

/** Generated alias around `trpc.cover.setTiltPosition.useMutation`. */
export const useCoverSetTiltPosition: typeof trpc.cover.setTiltPosition.useMutation = trpc.cover.setTiltPosition.useMutation

/** Generated alias around `trpc.cover.getStatus.useQuery`. */
export const useCoverGetStatus: typeof trpc.cover.getStatus.useQuery = trpc.cover.getStatus.useQuery

/** Generated alias around `trpc.dayNight.getOptions.useQuery`. */
export const useDayNightGetOptions: typeof trpc.dayNight.getOptions.useQuery = trpc.dayNight.getOptions.useQuery

/** Generated alias around `trpc.dayNight.setSettings.useMutation`. */
export const useDayNightSetSettings: typeof trpc.dayNight.setSettings.useMutation = trpc.dayNight.setSettings.useMutation

/** Generated alias around `trpc.dayNight.getStatus.useQuery`. */
export const useDayNightGetStatus: typeof trpc.dayNight.getStatus.useQuery = trpc.dayNight.getStatus.useQuery

/** Generated alias around `trpc.decoder.getInfo.useQuery`. */
export const useDecoderGetInfo: typeof trpc.decoder.getInfo.useQuery = trpc.decoder.getInfo.useQuery

/** Generated alias around `trpc.decoder.reprobeHwaccel.useMutation`. */
export const useDecoderReprobeHwaccel: typeof trpc.decoder.reprobeHwaccel.useMutation = trpc.decoder.reprobeHwaccel.useMutation

/** Generated alias around `trpc.detectionPipeline.getDeviceSettingsContribution.useQuery`. */
export const useDetectionPipelineGetDeviceSettingsContribution: typeof trpc.detectionPipeline.getDeviceSettingsContribution.useQuery = trpc.detectionPipeline.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.detectionPipeline.getDeviceLiveContribution.useQuery`. */
export const useDetectionPipelineGetDeviceLiveContribution: typeof trpc.detectionPipeline.getDeviceLiveContribution.useQuery = trpc.detectionPipeline.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.detectionPipeline.applyDeviceSettingsPatch.useMutation`. */
export const useDetectionPipelineApplyDeviceSettingsPatch: typeof trpc.detectionPipeline.applyDeviceSettingsPatch.useMutation = trpc.detectionPipeline.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.deviceAdminLink.getAdminLink.useQuery`. */
export const useDeviceAdminLinkGetAdminLink: typeof trpc.deviceAdminLink.getAdminLink.useQuery = trpc.deviceAdminLink.getAdminLink.useQuery

/** Generated alias around `trpc.deviceAdoption.listCandidateFilters.useQuery`. */
export const useDeviceAdoptionListCandidateFilters: typeof trpc.deviceAdoption.listCandidateFilters.useQuery = trpc.deviceAdoption.listCandidateFilters.useQuery

/** Generated alias around `trpc.deviceAdoption.listCandidates.useQuery`. */
export const useDeviceAdoptionListCandidates: typeof trpc.deviceAdoption.listCandidates.useQuery = trpc.deviceAdoption.listCandidates.useQuery

/** Generated alias around `trpc.deviceAdoption.getCandidate.useQuery`. */
export const useDeviceAdoptionGetCandidate: typeof trpc.deviceAdoption.getCandidate.useQuery = trpc.deviceAdoption.getCandidate.useQuery

/** Generated alias around `trpc.deviceAdoption.refresh.useMutation`. */
export const useDeviceAdoptionRefresh: typeof trpc.deviceAdoption.refresh.useMutation = trpc.deviceAdoption.refresh.useMutation

/** Generated alias around `trpc.deviceAdoption.adopt.useMutation`. */
export const useDeviceAdoptionAdopt: typeof trpc.deviceAdoption.adopt.useMutation = trpc.deviceAdoption.adopt.useMutation

/** Generated alias around `trpc.deviceAdoption.release.useMutation`. */
export const useDeviceAdoptionRelease: typeof trpc.deviceAdoption.release.useMutation = trpc.deviceAdoption.release.useMutation

/** Generated alias around `trpc.deviceAdoption.resync.useMutation`. */
export const useDeviceAdoptionResync: typeof trpc.deviceAdoption.resync.useMutation = trpc.deviceAdoption.resync.useMutation

/** Generated alias around `trpc.deviceAdoption.getStatus.useQuery`. */
export const useDeviceAdoptionGetStatus: typeof trpc.deviceAdoption.getStatus.useQuery = trpc.deviceAdoption.getStatus.useQuery

/** Generated alias around `trpc.deviceCredentials.listDeviceCredentials.useQuery`. */
export const useDeviceCredentialsListDeviceCredentials: typeof trpc.deviceCredentials.listDeviceCredentials.useQuery = trpc.deviceCredentials.listDeviceCredentials.useQuery

/** Generated alias around `trpc.deviceCredentials.startEnrollment.useMutation`. */
export const useDeviceCredentialsStartEnrollment: typeof trpc.deviceCredentials.startEnrollment.useMutation = trpc.deviceCredentials.startEnrollment.useMutation

/** Generated alias around `trpc.deviceCredentials.revokeDeviceCredential.useMutation`. */
export const useDeviceCredentialsRevokeDeviceCredential: typeof trpc.deviceCredentials.revokeDeviceCredential.useMutation = trpc.deviceCredentials.revokeDeviceCredential.useMutation

/** Generated alias around `trpc.deviceCredentials.getDeviceCertificateSettings.useQuery`. */
export const useDeviceCredentialsGetDeviceCertificateSettings: typeof trpc.deviceCredentials.getDeviceCertificateSettings.useQuery = trpc.deviceCredentials.getDeviceCertificateSettings.useQuery

/** Generated alias around `trpc.deviceCredentials.setDeviceCertificateSettings.useMutation`. */
export const useDeviceCredentialsSetDeviceCertificateSettings: typeof trpc.deviceCredentials.setDeviceCertificateSettings.useMutation = trpc.deviceCredentials.setDeviceCertificateSettings.useMutation

/** Generated alias around `trpc.deviceCredentials.deleteDeviceCredential.useMutation`. */
export const useDeviceCredentialsDeleteDeviceCredential: typeof trpc.deviceCredentials.deleteDeviceCredential.useMutation = trpc.deviceCredentials.deleteDeviceCredential.useMutation

/** Generated alias around `trpc.deviceCredentials.getDeviceCaStatus.useQuery`. */
export const useDeviceCredentialsGetDeviceCaStatus: typeof trpc.deviceCredentials.getDeviceCaStatus.useQuery = trpc.deviceCredentials.getDeviceCaStatus.useQuery

/** Generated alias around `trpc.deviceCredentials.renameDeviceCredential.useMutation`. */
export const useDeviceCredentialsRenameDeviceCredential: typeof trpc.deviceCredentials.renameDeviceCredential.useMutation = trpc.deviceCredentials.renameDeviceCredential.useMutation

/** Generated alias around `trpc.deviceDiscovery.listDiscovered.useQuery`. */
export const useDeviceDiscoveryListDiscovered: typeof trpc.deviceDiscovery.listDiscovered.useQuery = trpc.deviceDiscovery.listDiscovered.useQuery

/** Generated alias around `trpc.deviceDiscovery.refreshDiscovery.useMutation`. */
export const useDeviceDiscoveryRefreshDiscovery: typeof trpc.deviceDiscovery.refreshDiscovery.useMutation = trpc.deviceDiscovery.refreshDiscovery.useMutation

/** Generated alias around `trpc.deviceDiscovery.adoptDevice.useMutation`. */
export const useDeviceDiscoveryAdoptDevice: typeof trpc.deviceDiscovery.adoptDevice.useMutation = trpc.deviceDiscovery.adoptDevice.useMutation

/** Generated alias around `trpc.deviceDiscovery.releaseDevice.useMutation`. */
export const useDeviceDiscoveryReleaseDevice: typeof trpc.deviceDiscovery.releaseDevice.useMutation = trpc.deviceDiscovery.releaseDevice.useMutation

/** Generated alias around `trpc.deviceDiscovery.getStatus.useQuery`. */
export const useDeviceDiscoveryGetStatus: typeof trpc.deviceDiscovery.getStatus.useQuery = trpc.deviceDiscovery.getStatus.useQuery

/** Generated alias around `trpc.deviceExport.getStatus.useQuery`. */
export const useDeviceExportGetStatus: typeof trpc.deviceExport.getStatus.useQuery = trpc.deviceExport.getStatus.useQuery

/** Generated alias around `trpc.deviceExport.listSupportedDeviceKinds.useQuery`. */
export const useDeviceExportListSupportedDeviceKinds: typeof trpc.deviceExport.listSupportedDeviceKinds.useQuery = trpc.deviceExport.listSupportedDeviceKinds.useQuery

/** Generated alias around `trpc.deviceExport.listExposedDevices.useQuery`. */
export const useDeviceExportListExposedDevices: typeof trpc.deviceExport.listExposedDevices.useQuery = trpc.deviceExport.listExposedDevices.useQuery

/** Generated alias around `trpc.deviceExport.exposeDevice.useMutation`. */
export const useDeviceExportExposeDevice: typeof trpc.deviceExport.exposeDevice.useMutation = trpc.deviceExport.exposeDevice.useMutation

/** Generated alias around `trpc.deviceExport.unexposeDevice.useMutation`. */
export const useDeviceExportUnexposeDevice: typeof trpc.deviceExport.unexposeDevice.useMutation = trpc.deviceExport.unexposeDevice.useMutation

/** Generated alias around `trpc.deviceExport.getDeviceSettingsContribution.useQuery`. */
export const useDeviceExportGetDeviceSettingsContribution: typeof trpc.deviceExport.getDeviceSettingsContribution.useQuery = trpc.deviceExport.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.deviceExport.getDeviceLiveContribution.useQuery`. */
export const useDeviceExportGetDeviceLiveContribution: typeof trpc.deviceExport.getDeviceLiveContribution.useQuery = trpc.deviceExport.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.deviceExport.applyDeviceSettingsPatch.useMutation`. */
export const useDeviceExportApplyDeviceSettingsPatch: typeof trpc.deviceExport.applyDeviceSettingsPatch.useMutation = trpc.deviceExport.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.deviceExtension.listSources.useQuery`. */
export const useDeviceExtensionListSources: typeof trpc.deviceExtension.listSources.useQuery = trpc.deviceExtension.listSources.useQuery

/** Generated alias around `trpc.deviceExtension.listSlots.useQuery`. */
export const useDeviceExtensionListSlots: typeof trpc.deviceExtension.listSlots.useQuery = trpc.deviceExtension.listSlots.useQuery

/** Generated alias around `trpc.deviceExtension.listCandidates.useQuery`. */
export const useDeviceExtensionListCandidates: typeof trpc.deviceExtension.listCandidates.useQuery = trpc.deviceExtension.listCandidates.useQuery

/** Generated alias around `trpc.deviceExtension.setSlot.useMutation`. */
export const useDeviceExtensionSetSlot: typeof trpc.deviceExtension.setSlot.useMutation = trpc.deviceExtension.setSlot.useMutation

/** Generated alias around `trpc.deviceHistory.listSeries.useQuery`. */
export const useDeviceHistoryListSeries: typeof trpc.deviceHistory.listSeries.useQuery = trpc.deviceHistory.listSeries.useQuery

/** Generated alias around `trpc.deviceHistory.listNodeSeries.useQuery`. */
export const useDeviceHistoryListNodeSeries: typeof trpc.deviceHistory.listNodeSeries.useQuery = trpc.deviceHistory.listNodeSeries.useQuery

/** Generated alias around `trpc.deviceHistory.query.useQuery`. */
export const useDeviceHistoryQuery: typeof trpc.deviceHistory.query.useQuery = trpc.deviceHistory.query.useQuery

/** Generated alias around `trpc.deviceHistory.queryNode.useQuery`. */
export const useDeviceHistoryQueryNode: typeof trpc.deviceHistory.queryNode.useQuery = trpc.deviceHistory.queryNode.useQuery

/** Generated alias around `trpc.deviceHistory.queryMany.useQuery`. */
export const useDeviceHistoryQueryMany: typeof trpc.deviceHistory.queryMany.useQuery = trpc.deviceHistory.queryMany.useQuery

/** Generated alias around `trpc.deviceHistory.declareSeries.useMutation`. */
export const useDeviceHistoryDeclareSeries: typeof trpc.deviceHistory.declareSeries.useMutation = trpc.deviceHistory.declareSeries.useMutation

/** Generated alias around `trpc.deviceHistory.record.useMutation`. */
export const useDeviceHistoryRecord: typeof trpc.deviceHistory.record.useMutation = trpc.deviceHistory.record.useMutation

/** Generated alias around `trpc.deviceHistory.recordBuckets.useMutation`. */
export const useDeviceHistoryRecordBuckets: typeof trpc.deviceHistory.recordBuckets.useMutation = trpc.deviceHistory.recordBuckets.useMutation

/** Generated alias around `trpc.deviceHistory.getDeviceEnabled.useQuery`. */
export const useDeviceHistoryGetDeviceEnabled: typeof trpc.deviceHistory.getDeviceEnabled.useQuery = trpc.deviceHistory.getDeviceEnabled.useQuery

/** Generated alias around `trpc.deviceHistory.setDeviceEnabled.useMutation`. */
export const useDeviceHistorySetDeviceEnabled: typeof trpc.deviceHistory.setDeviceEnabled.useMutation = trpc.deviceHistory.setDeviceEnabled.useMutation

/** Generated alias around `trpc.deviceHistory.getStatus.useQuery`. */
export const useDeviceHistoryGetStatus: typeof trpc.deviceHistory.getStatus.useQuery = trpc.deviceHistory.getStatus.useQuery

/** Generated alias around `trpc.deviceHistory.listOrphanSeries.useQuery`. */
export const useDeviceHistoryListOrphanSeries: typeof trpc.deviceHistory.listOrphanSeries.useQuery = trpc.deviceHistory.listOrphanSeries.useQuery

/** Generated alias around `trpc.deviceHistory.deleteOrphanSeries.useMutation`. */
export const useDeviceHistoryDeleteOrphanSeries: typeof trpc.deviceHistory.deleteOrphanSeries.useMutation = trpc.deviceHistory.deleteOrphanSeries.useMutation

/** Generated alias around `trpc.deviceManager.allocateDeviceId.useMutation`. */
export const useDeviceManagerAllocateDeviceId: typeof trpc.deviceManager.allocateDeviceId.useMutation = trpc.deviceManager.allocateDeviceId.useMutation

/** Generated alias around `trpc.deviceManager.migrateDevice.useMutation`. */
export const useDeviceManagerMigrateDevice: typeof trpc.deviceManager.migrateDevice.useMutation = trpc.deviceManager.migrateDevice.useMutation

/** Generated alias around `trpc.deviceManager.registerDevice.useMutation`. */
export const useDeviceManagerRegisterDevice: typeof trpc.deviceManager.registerDevice.useMutation = trpc.deviceManager.registerDevice.useMutation

/** Generated alias around `trpc.deviceManager.removeDevice.useMutation`. */
export const useDeviceManagerRemoveDevice: typeof trpc.deviceManager.removeDevice.useMutation = trpc.deviceManager.removeDevice.useMutation

/** Generated alias around `trpc.deviceManager.persistConfig.useMutation`. */
export const useDeviceManagerPersistConfig: typeof trpc.deviceManager.persistConfig.useMutation = trpc.deviceManager.persistConfig.useMutation

/** Generated alias around `trpc.deviceManager.loadConfig.useQuery`. */
export const useDeviceManagerLoadConfig: typeof trpc.deviceManager.loadConfig.useQuery = trpc.deviceManager.loadConfig.useQuery

/** Generated alias around `trpc.deviceManager.loadRuntimeState.useQuery`. */
export const useDeviceManagerLoadRuntimeState: typeof trpc.deviceManager.loadRuntimeState.useQuery = trpc.deviceManager.loadRuntimeState.useQuery

/** Generated alias around `trpc.deviceManager.loadMeta.useQuery`. */
export const useDeviceManagerLoadMeta: typeof trpc.deviceManager.loadMeta.useQuery = trpc.deviceManager.loadMeta.useQuery

/** Generated alias around `trpc.deviceManager.setName.useMutation`. */
export const useDeviceManagerSetName: typeof trpc.deviceManager.setName.useMutation = trpc.deviceManager.setName.useMutation

/** Generated alias around `trpc.deviceManager.setLocation.useMutation`. */
export const useDeviceManagerSetLocation: typeof trpc.deviceManager.setLocation.useMutation = trpc.deviceManager.setLocation.useMutation

/** Generated alias around `trpc.deviceManager.setType.useMutation`. */
export const useDeviceManagerSetType: typeof trpc.deviceManager.setType.useMutation = trpc.deviceManager.setType.useMutation

/** Generated alias around `trpc.deviceManager.setIntegrationId.useMutation`. */
export const useDeviceManagerSetIntegrationId: typeof trpc.deviceManager.setIntegrationId.useMutation = trpc.deviceManager.setIntegrationId.useMutation

/** Generated alias around `trpc.deviceManager.setLinkDeviceId.useMutation`. */
export const useDeviceManagerSetLinkDeviceId: typeof trpc.deviceManager.setLinkDeviceId.useMutation = trpc.deviceManager.setLinkDeviceId.useMutation

/** Generated alias around `trpc.deviceManager.setPrimaryChildEntityId.useMutation`. */
export const useDeviceManagerSetPrimaryChildEntityId: typeof trpc.deviceManager.setPrimaryChildEntityId.useMutation = trpc.deviceManager.setPrimaryChildEntityId.useMutation

/** Generated alias around `trpc.deviceManager.setChildLayout.useMutation`. */
export const useDeviceManagerSetChildLayout: typeof trpc.deviceManager.setChildLayout.useMutation = trpc.deviceManager.setChildLayout.useMutation

/** Generated alias around `trpc.deviceManager.setDisplay.useMutation`. */
export const useDeviceManagerSetDisplay: typeof trpc.deviceManager.setDisplay.useMutation = trpc.deviceManager.setDisplay.useMutation

/** Generated alias around `trpc.deviceManager.getRoleDisplayDefaults.useQuery`. */
export const useDeviceManagerGetRoleDisplayDefaults: typeof trpc.deviceManager.getRoleDisplayDefaults.useQuery = trpc.deviceManager.getRoleDisplayDefaults.useQuery

/** Generated alias around `trpc.deviceManager.setRoleDisplayDefaults.useMutation`. */
export const useDeviceManagerSetRoleDisplayDefaults: typeof trpc.deviceManager.setRoleDisplayDefaults.useMutation = trpc.deviceManager.setRoleDisplayDefaults.useMutation

/** Generated alias around `trpc.deviceManager.getWireableFields.useQuery`. */
export const useDeviceManagerGetWireableFields: typeof trpc.deviceManager.getWireableFields.useQuery = trpc.deviceManager.getWireableFields.useQuery

/** Generated alias around `trpc.deviceManager.setRole.useMutation`. */
export const useDeviceManagerSetRole: typeof trpc.deviceManager.setRole.useMutation = trpc.deviceManager.setRole.useMutation

/** Generated alias around `trpc.deviceManager.applyInitialMeta.useMutation`. */
export const useDeviceManagerApplyInitialMeta: typeof trpc.deviceManager.applyInitialMeta.useMutation = trpc.deviceManager.applyInitialMeta.useMutation

/** Generated alias around `trpc.deviceManager.setMetadata.useMutation`. */
export const useDeviceManagerSetMetadata: typeof trpc.deviceManager.setMetadata.useMutation = trpc.deviceManager.setMetadata.useMutation

/** Generated alias around `trpc.deviceManager.listLocations.useQuery`. */
export const useDeviceManagerListLocations: typeof trpc.deviceManager.listLocations.useQuery = trpc.deviceManager.listLocations.useQuery

/** Generated alias around `trpc.deviceManager.addLocation.useMutation`. */
export const useDeviceManagerAddLocation: typeof trpc.deviceManager.addLocation.useMutation = trpc.deviceManager.addLocation.useMutation

/** Generated alias around `trpc.deviceManager.removeLocation.useMutation`. */
export const useDeviceManagerRemoveLocation: typeof trpc.deviceManager.removeLocation.useMutation = trpc.deviceManager.removeLocation.useMutation

/** Generated alias around `trpc.deviceManager.renameLocation.useMutation`. */
export const useDeviceManagerRenameLocation: typeof trpc.deviceManager.renameLocation.useMutation = trpc.deviceManager.renameLocation.useMutation

/** Generated alias around `trpc.deviceManager.listLocationIcons.useQuery`. */
export const useDeviceManagerListLocationIcons: typeof trpc.deviceManager.listLocationIcons.useQuery = trpc.deviceManager.listLocationIcons.useQuery

/** Generated alias around `trpc.deviceManager.setLocationIcon.useMutation`. */
export const useDeviceManagerSetLocationIcon: typeof trpc.deviceManager.setLocationIcon.useMutation = trpc.deviceManager.setLocationIcon.useMutation

/** Generated alias around `trpc.deviceManager.listLocationDescriptions.useQuery`. */
export const useDeviceManagerListLocationDescriptions: typeof trpc.deviceManager.listLocationDescriptions.useQuery = trpc.deviceManager.listLocationDescriptions.useQuery

/** Generated alias around `trpc.deviceManager.setLocationDescription.useMutation`. */
export const useDeviceManagerSetLocationDescription: typeof trpc.deviceManager.setLocationDescription.useMutation = trpc.deviceManager.setLocationDescription.useMutation

/** Generated alias around `trpc.deviceManager.listSiteZones.useQuery`. */
export const useDeviceManagerListSiteZones: typeof trpc.deviceManager.listSiteZones.useQuery = trpc.deviceManager.listSiteZones.useQuery

/** Generated alias around `trpc.deviceManager.setSiteZone.useMutation`. */
export const useDeviceManagerSetSiteZone: typeof trpc.deviceManager.setSiteZone.useMutation = trpc.deviceManager.setSiteZone.useMutation

/** Generated alias around `trpc.deviceManager.removeSiteZone.useMutation`. */
export const useDeviceManagerRemoveSiteZone: typeof trpc.deviceManager.removeSiteZone.useMutation = trpc.deviceManager.removeSiteZone.useMutation

/** Generated alias around `trpc.deviceManager.renameSiteZone.useMutation`. */
export const useDeviceManagerRenameSiteZone: typeof trpc.deviceManager.renameSiteZone.useMutation = trpc.deviceManager.renameSiteZone.useMutation

/** Generated alias around `trpc.deviceManager.setLocationZone.useMutation`. */
export const useDeviceManagerSetLocationZone: typeof trpc.deviceManager.setLocationZone.useMutation = trpc.deviceManager.setLocationZone.useMutation

/** Generated alias around `trpc.deviceManager.setDisabled.useMutation`. */
export const useDeviceManagerSetDisabled: typeof trpc.deviceManager.setDisabled.useMutation = trpc.deviceManager.setDisabled.useMutation

/** Generated alias around `trpc.deviceManager.listPersistedByAddon.useQuery`. */
export const useDeviceManagerListPersistedByAddon: typeof trpc.deviceManager.listPersistedByAddon.useQuery = trpc.deviceManager.listPersistedByAddon.useQuery

/** Generated alias around `trpc.deviceManager.listAll.useQuery`. */
export const useDeviceManagerListAll: typeof trpc.deviceManager.listAll.useQuery = trpc.deviceManager.listAll.useQuery

/** Generated alias around `trpc.deviceManager.getDevice.useQuery`. */
export const useDeviceManagerGetDevice: typeof trpc.deviceManager.getDevice.useQuery = trpc.deviceManager.getDevice.useQuery

/** Generated alias around `trpc.deviceManager.getChildren.useQuery`. */
export const useDeviceManagerGetChildren: typeof trpc.deviceManager.getChildren.useQuery = trpc.deviceManager.getChildren.useQuery

/** Generated alias around `trpc.deviceManager.getChildrenBatch.useQuery`. */
export const useDeviceManagerGetChildrenBatch: typeof trpc.deviceManager.getChildrenBatch.useQuery = trpc.deviceManager.getChildrenBatch.useQuery

/** Generated alias around `trpc.deviceManager.getLinkedDevices.useQuery`. */
export const useDeviceManagerGetLinkedDevices: typeof trpc.deviceManager.getLinkedDevices.useQuery = trpc.deviceManager.getLinkedDevices.useQuery

/** Generated alias around `trpc.deviceManager.getLinkedDevicesBatch.useQuery`. */
export const useDeviceManagerGetLinkedDevicesBatch: typeof trpc.deviceManager.getLinkedDevicesBatch.useQuery = trpc.deviceManager.getLinkedDevicesBatch.useQuery

/** Generated alias around `trpc.deviceManager.getStreamSources.useQuery`. */
export const useDeviceManagerGetStreamSources: typeof trpc.deviceManager.getStreamSources.useQuery = trpc.deviceManager.getStreamSources.useQuery

/** Generated alias around `trpc.deviceManager.getConfigSchema.useQuery`. */
export const useDeviceManagerGetConfigSchema: typeof trpc.deviceManager.getConfigSchema.useQuery = trpc.deviceManager.getConfigSchema.useQuery

/** Generated alias around `trpc.deviceManager.getSettingsSchema.useQuery`. */
export const useDeviceManagerGetSettingsSchema: typeof trpc.deviceManager.getSettingsSchema.useQuery = trpc.deviceManager.getSettingsSchema.useQuery

/** Generated alias around `trpc.deviceManager.updateConfig.useMutation`. */
export const useDeviceManagerUpdateConfig: typeof trpc.deviceManager.updateConfig.useMutation = trpc.deviceManager.updateConfig.useMutation

/** Generated alias around `trpc.deviceManager.enable.useMutation`. */
export const useDeviceManagerEnable: typeof trpc.deviceManager.enable.useMutation = trpc.deviceManager.enable.useMutation

/** Generated alias around `trpc.deviceManager.disable.useMutation`. */
export const useDeviceManagerDisable: typeof trpc.deviceManager.disable.useMutation = trpc.deviceManager.disable.useMutation

/** Generated alias around `trpc.deviceManager.remove.useMutation`. */
export const useDeviceManagerRemove: typeof trpc.deviceManager.remove.useMutation = trpc.deviceManager.remove.useMutation

/** Generated alias around `trpc.deviceManager.listDeletedSince.useQuery`. */
export const useDeviceManagerListDeletedSince: typeof trpc.deviceManager.listDeletedSince.useQuery = trpc.deviceManager.listDeletedSince.useQuery

/** Generated alias around `trpc.deviceManager.cleanupDeletedDevicesData.useMutation`. */
export const useDeviceManagerCleanupDeletedDevicesData: typeof trpc.deviceManager.cleanupDeletedDevicesData.useMutation = trpc.deviceManager.cleanupDeletedDevicesData.useMutation

/** Generated alias around `trpc.deviceManager.removeByIntegration.useMutation`. */
export const useDeviceManagerRemoveByIntegration: typeof trpc.deviceManager.removeByIntegration.useMutation = trpc.deviceManager.removeByIntegration.useMutation

/** Generated alias around `trpc.deviceManager.getStreamProfileMap.useQuery`. */
export const useDeviceManagerGetStreamProfileMap: typeof trpc.deviceManager.getStreamProfileMap.useQuery = trpc.deviceManager.getStreamProfileMap.useQuery

/** Generated alias around `trpc.deviceManager.setStreamProfileMap.useMutation`. */
export const useDeviceManagerSetStreamProfileMap: typeof trpc.deviceManager.setStreamProfileMap.useMutation = trpc.deviceManager.setStreamProfileMap.useMutation

/** Generated alias around `trpc.deviceManager.probeStreams.useMutation`. */
export const useDeviceManagerProbeStreams: typeof trpc.deviceManager.probeStreams.useMutation = trpc.deviceManager.probeStreams.useMutation

/** Generated alias around `trpc.deviceManager.getBindings.useQuery`. */
export const useDeviceManagerGetBindings: typeof trpc.deviceManager.getBindings.useQuery = trpc.deviceManager.getBindings.useQuery

/** Generated alias around `trpc.deviceManager.getBindingsBatch.useQuery`. */
export const useDeviceManagerGetBindingsBatch: typeof trpc.deviceManager.getBindingsBatch.useQuery = trpc.deviceManager.getBindingsBatch.useQuery

/** Generated alias around `trpc.deviceManager.getAllBindings.useQuery`. */
export const useDeviceManagerGetAllBindings: typeof trpc.deviceManager.getAllBindings.useQuery = trpc.deviceManager.getAllBindings.useQuery

/** Generated alias around `trpc.deviceManager.listDeviceIdsByCaps.useQuery`. */
export const useDeviceManagerListDeviceIdsByCaps: typeof trpc.deviceManager.listDeviceIdsByCaps.useQuery = trpc.deviceManager.listDeviceIdsByCaps.useQuery

/** Generated alias around `trpc.deviceManager.setWrapperActive.useMutation`. */
export const useDeviceManagerSetWrapperActive: typeof trpc.deviceManager.setWrapperActive.useMutation = trpc.deviceManager.setWrapperActive.useMutation

/** Generated alias around `trpc.deviceManager.getWrapperActivation.useQuery`. */
export const useDeviceManagerGetWrapperActivation: typeof trpc.deviceManager.getWrapperActivation.useQuery = trpc.deviceManager.getWrapperActivation.useQuery

/** Generated alias around `trpc.deviceManager.listWrappersForCap.useQuery`. */
export const useDeviceManagerListWrappersForCap: typeof trpc.deviceManager.listWrappersForCap.useQuery = trpc.deviceManager.listWrappersForCap.useQuery

/** Generated alias around `trpc.deviceManager.listBindableCapsForDeviceType.useQuery`. */
export const useDeviceManagerListBindableCapsForDeviceType: typeof trpc.deviceManager.listBindableCapsForDeviceType.useQuery = trpc.deviceManager.listBindableCapsForDeviceType.useQuery

/** Generated alias around `trpc.deviceManager.getDeviceSettingsAggregate.useQuery`. */
export const useDeviceManagerGetDeviceSettingsAggregate: typeof trpc.deviceManager.getDeviceSettingsAggregate.useQuery = trpc.deviceManager.getDeviceSettingsAggregate.useQuery

/** Generated alias around `trpc.deviceManager.getDeviceLiveInfoAggregate.useQuery`. */
export const useDeviceManagerGetDeviceLiveInfoAggregate: typeof trpc.deviceManager.getDeviceLiveInfoAggregate.useQuery = trpc.deviceManager.getDeviceLiveInfoAggregate.useQuery

/** Generated alias around `trpc.deviceManager.getDeviceAggregate.useQuery`. */
export const useDeviceManagerGetDeviceAggregate: typeof trpc.deviceManager.getDeviceAggregate.useQuery = trpc.deviceManager.getDeviceAggregate.useQuery

/** Generated alias around `trpc.deviceManager.runDeviceAction.useMutation`. */
export const useDeviceManagerRunDeviceAction: typeof trpc.deviceManager.runDeviceAction.useMutation = trpc.deviceManager.runDeviceAction.useMutation

/** Generated alias around `trpc.deviceManager.updateDeviceField.useMutation`. */
export const useDeviceManagerUpdateDeviceField: typeof trpc.deviceManager.updateDeviceField.useMutation = trpc.deviceManager.updateDeviceField.useMutation

/** Generated alias around `trpc.deviceManager.updateDeviceFieldsBatch.useMutation`. */
export const useDeviceManagerUpdateDeviceFieldsBatch: typeof trpc.deviceManager.updateDeviceFieldsBatch.useMutation = trpc.deviceManager.updateDeviceFieldsBatch.useMutation

/** Generated alias around `trpc.deviceManager.discoverDevices.useMutation`. */
export const useDeviceManagerDiscoverDevices: typeof trpc.deviceManager.discoverDevices.useMutation = trpc.deviceManager.discoverDevices.useMutation

/** Generated alias around `trpc.deviceManager.adoptDevice.useMutation`. */
export const useDeviceManagerAdoptDevice: typeof trpc.deviceManager.adoptDevice.useMutation = trpc.deviceManager.adoptDevice.useMutation

/** Generated alias around `trpc.deviceManager.getCreationSchema.useQuery`. */
export const useDeviceManagerGetCreationSchema: typeof trpc.deviceManager.getCreationSchema.useQuery = trpc.deviceManager.getCreationSchema.useQuery

/** Generated alias around `trpc.deviceManager.createDevice.useMutation`. */
export const useDeviceManagerCreateDevice: typeof trpc.deviceManager.createDevice.useMutation = trpc.deviceManager.createDevice.useMutation

/** Generated alias around `trpc.deviceManager.testCreationField.useMutation`. */
export const useDeviceManagerTestCreationField: typeof trpc.deviceManager.testCreationField.useMutation = trpc.deviceManager.testCreationField.useMutation

/** Generated alias around `trpc.deviceManager.adoptionListCandidateFilters.useQuery`. */
export const useDeviceManagerAdoptionListCandidateFilters: typeof trpc.deviceManager.adoptionListCandidateFilters.useQuery = trpc.deviceManager.adoptionListCandidateFilters.useQuery

/** Generated alias around `trpc.deviceManager.adoptionListCandidates.useQuery`. */
export const useDeviceManagerAdoptionListCandidates: typeof trpc.deviceManager.adoptionListCandidates.useQuery = trpc.deviceManager.adoptionListCandidates.useQuery

/** Generated alias around `trpc.deviceManager.adoptionRefresh.useMutation`. */
export const useDeviceManagerAdoptionRefresh: typeof trpc.deviceManager.adoptionRefresh.useMutation = trpc.deviceManager.adoptionRefresh.useMutation

/** Generated alias around `trpc.deviceManager.adoptionAdopt.useMutation`. */
export const useDeviceManagerAdoptionAdopt: typeof trpc.deviceManager.adoptionAdopt.useMutation = trpc.deviceManager.adoptionAdopt.useMutation

/** Generated alias around `trpc.deviceManager.adoptionRelease.useMutation`. */
export const useDeviceManagerAdoptionRelease: typeof trpc.deviceManager.adoptionRelease.useMutation = trpc.deviceManager.adoptionRelease.useMutation

/** Generated alias around `trpc.deviceManager.adoptionStartJob.useMutation`. */
export const useDeviceManagerAdoptionStartJob: typeof trpc.deviceManager.adoptionStartJob.useMutation = trpc.deviceManager.adoptionStartJob.useMutation

/** Generated alias around `trpc.deviceManager.adoptionListJobs.useQuery`. */
export const useDeviceManagerAdoptionListJobs: typeof trpc.deviceManager.adoptionListJobs.useQuery = trpc.deviceManager.adoptionListJobs.useQuery

/** Generated alias around `trpc.deviceManager.adoptionCancelJob.useMutation`. */
export const useDeviceManagerAdoptionCancelJob: typeof trpc.deviceManager.adoptionCancelJob.useMutation = trpc.deviceManager.adoptionCancelJob.useMutation

/** Generated alias around `trpc.deviceManager.adoptionResync.useMutation`. */
export const useDeviceManagerAdoptionResync: typeof trpc.deviceManager.adoptionResync.useMutation = trpc.deviceManager.adoptionResync.useMutation

/** Generated alias around `trpc.deviceManager.discoveryProviders.useQuery`. */
export const useDeviceManagerDiscoveryProviders: typeof trpc.deviceManager.discoveryProviders.useQuery = trpc.deviceManager.discoveryProviders.useQuery

/** Generated alias around `trpc.deviceManager.discoverAllProviders.useMutation`. */
export const useDeviceManagerDiscoverAllProviders: typeof trpc.deviceManager.discoverAllProviders.useMutation = trpc.deviceManager.discoverAllProviders.useMutation

/** Generated alias around `trpc.deviceManager.discoverProvider.useMutation`. */
export const useDeviceManagerDiscoverProvider: typeof trpc.deviceManager.discoverProvider.useMutation = trpc.deviceManager.discoverProvider.useMutation

/** Generated alias around `trpc.deviceManager.providerCreationType.useQuery`. */
export const useDeviceManagerProviderCreationType: typeof trpc.deviceManager.providerCreationType.useQuery = trpc.deviceManager.providerCreationType.useQuery

/** Generated alias around `trpc.deviceManager.providerDiscoveryParamsSchema.useQuery`. */
export const useDeviceManagerProviderDiscoveryParamsSchema: typeof trpc.deviceManager.providerDiscoveryParamsSchema.useQuery = trpc.deviceManager.providerDiscoveryParamsSchema.useQuery

/** Generated alias around `trpc.deviceManager.testField.useMutation`. */
export const useDeviceManagerTestField: typeof trpc.deviceManager.testField.useMutation = trpc.deviceManager.testField.useMutation

/** Generated alias around `trpc.deviceManager.getDeviceStatusAggregate.useQuery`. */
export const useDeviceManagerGetDeviceStatusAggregate: typeof trpc.deviceManager.getDeviceStatusAggregate.useQuery = trpc.deviceManager.getDeviceStatusAggregate.useQuery

/** Generated alias around `trpc.deviceManager.getDeviceStatusAggregateBatch.useQuery`. */
export const useDeviceManagerGetDeviceStatusAggregateBatch: typeof trpc.deviceManager.getDeviceStatusAggregateBatch.useQuery = trpc.deviceManager.getDeviceStatusAggregateBatch.useQuery

/** Generated alias around `trpc.deviceOps.getStreamSources.useQuery`. */
export const useDeviceOpsGetStreamSources: typeof trpc.deviceOps.getStreamSources.useQuery = trpc.deviceOps.getStreamSources.useQuery

/** Generated alias around `trpc.deviceOps.getConfigEntries.useQuery`. */
export const useDeviceOpsGetConfigEntries: typeof trpc.deviceOps.getConfigEntries.useQuery = trpc.deviceOps.getConfigEntries.useQuery

/** Generated alias around `trpc.deviceOps.setConfig.useMutation`. */
export const useDeviceOpsSetConfig: typeof trpc.deviceOps.setConfig.useMutation = trpc.deviceOps.setConfig.useMutation

/** Generated alias around `trpc.deviceOps.runAction.useMutation`. */
export const useDeviceOpsRunAction: typeof trpc.deviceOps.runAction.useMutation = trpc.deviceOps.runAction.useMutation

/** Generated alias around `trpc.deviceOps.removeDevice.useMutation`. */
export const useDeviceOpsRemoveDevice: typeof trpc.deviceOps.removeDevice.useMutation = trpc.deviceOps.removeDevice.useMutation

/** Generated alias around `trpc.deviceOps.getSettingsSchema.useQuery`. */
export const useDeviceOpsGetSettingsSchema: typeof trpc.deviceOps.getSettingsSchema.useQuery = trpc.deviceOps.getSettingsSchema.useQuery

/** Generated alias around `trpc.deviceOps.getRawState.useQuery`. */
export const useDeviceOpsGetRawState: typeof trpc.deviceOps.getRawState.useQuery = trpc.deviceOps.getRawState.useQuery

/** Generated alias around `trpc.deviceProvider.start.useMutation`. */
export const useDeviceProviderStart: typeof trpc.deviceProvider.start.useMutation = trpc.deviceProvider.start.useMutation

/** Generated alias around `trpc.deviceProvider.stop.useMutation`. */
export const useDeviceProviderStop: typeof trpc.deviceProvider.stop.useMutation = trpc.deviceProvider.stop.useMutation

/** Generated alias around `trpc.deviceProvider.getStatus.useQuery`. */
export const useDeviceProviderGetStatus: typeof trpc.deviceProvider.getStatus.useQuery = trpc.deviceProvider.getStatus.useQuery

/** Generated alias around `trpc.deviceProvider.getDevices.useQuery`. */
export const useDeviceProviderGetDevices: typeof trpc.deviceProvider.getDevices.useQuery = trpc.deviceProvider.getDevices.useQuery

/** Generated alias around `trpc.deviceProvider.reloadDevice.useMutation`. */
export const useDeviceProviderReloadDevice: typeof trpc.deviceProvider.reloadDevice.useMutation = trpc.deviceProvider.reloadDevice.useMutation

/** Generated alias around `trpc.deviceProvider.supportsDiscovery.useQuery`. */
export const useDeviceProviderSupportsDiscovery: typeof trpc.deviceProvider.supportsDiscovery.useQuery = trpc.deviceProvider.supportsDiscovery.useQuery

/** Generated alias around `trpc.deviceProvider.discoverDevices.useMutation`. */
export const useDeviceProviderDiscoverDevices: typeof trpc.deviceProvider.discoverDevices.useMutation = trpc.deviceProvider.discoverDevices.useMutation

/** Generated alias around `trpc.deviceProvider.getDiscoveryParamsSchema.useQuery`. */
export const useDeviceProviderGetDiscoveryParamsSchema: typeof trpc.deviceProvider.getDiscoveryParamsSchema.useQuery = trpc.deviceProvider.getDiscoveryParamsSchema.useQuery

/** Generated alias around `trpc.deviceProvider.getManualCreationType.useQuery`. */
export const useDeviceProviderGetManualCreationType: typeof trpc.deviceProvider.getManualCreationType.useQuery = trpc.deviceProvider.getManualCreationType.useQuery

/** Generated alias around `trpc.deviceProvider.adoptDiscoveredDevice.useMutation`. */
export const useDeviceProviderAdoptDiscoveredDevice: typeof trpc.deviceProvider.adoptDiscoveredDevice.useMutation = trpc.deviceProvider.adoptDiscoveredDevice.useMutation

/** Generated alias around `trpc.deviceProvider.supportsManualCreation.useQuery`. */
export const useDeviceProviderSupportsManualCreation: typeof trpc.deviceProvider.supportsManualCreation.useQuery = trpc.deviceProvider.supportsManualCreation.useQuery

/** Generated alias around `trpc.deviceProvider.getChildCreationSchema.useQuery`. */
export const useDeviceProviderGetChildCreationSchema: typeof trpc.deviceProvider.getChildCreationSchema.useQuery = trpc.deviceProvider.getChildCreationSchema.useQuery

/** Generated alias around `trpc.deviceProvider.createDevice.useMutation`. */
export const useDeviceProviderCreateDevice: typeof trpc.deviceProvider.createDevice.useMutation = trpc.deviceProvider.createDevice.useMutation

/** Generated alias around `trpc.deviceProvider.testCreationField.useMutation`. */
export const useDeviceProviderTestCreationField: typeof trpc.deviceProvider.testCreationField.useMutation = trpc.deviceProvider.testCreationField.useMutation

/** Generated alias around `trpc.deviceState.getSnapshot.useQuery`. */
export const useDeviceStateGetSnapshot: typeof trpc.deviceState.getSnapshot.useQuery = trpc.deviceState.getSnapshot.useQuery

/** Generated alias around `trpc.deviceState.getCapSlice.useQuery`. */
export const useDeviceStateGetCapSlice: typeof trpc.deviceState.getCapSlice.useQuery = trpc.deviceState.getCapSlice.useQuery

/** Generated alias around `trpc.deviceState.getAllSnapshots.useQuery`. */
export const useDeviceStateGetAllSnapshots: typeof trpc.deviceState.getAllSnapshots.useQuery = trpc.deviceState.getAllSnapshots.useQuery

/** Generated alias around `trpc.deviceState.setCapSlice.useMutation`. */
export const useDeviceStateSetCapSlice: typeof trpc.deviceState.setCapSlice.useMutation = trpc.deviceState.setCapSlice.useMutation

/** Generated alias around `trpc.deviceState.claimFields.useMutation`. */
export const useDeviceStateClaimFields: typeof trpc.deviceState.claimFields.useMutation = trpc.deviceState.claimFields.useMutation

/** Generated alias around `trpc.deviceState.patchOwnedFields.useMutation`. */
export const useDeviceStatePatchOwnedFields: typeof trpc.deviceState.patchOwnedFields.useMutation = trpc.deviceState.patchOwnedFields.useMutation

/** Generated alias around `trpc.deviceState.releaseClaim.useMutation`. */
export const useDeviceStateReleaseClaim: typeof trpc.deviceState.releaseClaim.useMutation = trpc.deviceState.releaseClaim.useMutation

/** Generated alias around `trpc.deviceState.listClaims.useQuery`. */
export const useDeviceStateListClaims: typeof trpc.deviceState.listClaims.useQuery = trpc.deviceState.listClaims.useQuery

/** Generated alias around `trpc.deviceState.getNativeCapSlice.useQuery`. */
export const useDeviceStateGetNativeCapSlice: typeof trpc.deviceState.getNativeCapSlice.useQuery = trpc.deviceState.getNativeCapSlice.useQuery

/** Generated alias around `trpc.deviceStatus.getStatus.useQuery`. */
export const useDeviceStatusGetStatus: typeof trpc.deviceStatus.getStatus.useQuery = trpc.deviceStatus.getStatus.useQuery

/** Generated alias around `trpc.dishwasher.start.useMutation`. */
export const useDishwasherStart: typeof trpc.dishwasher.start.useMutation = trpc.dishwasher.start.useMutation

/** Generated alias around `trpc.dishwasher.pause.useMutation`. */
export const useDishwasherPause: typeof trpc.dishwasher.pause.useMutation = trpc.dishwasher.pause.useMutation

/** Generated alias around `trpc.dishwasher.resume.useMutation`. */
export const useDishwasherResume: typeof trpc.dishwasher.resume.useMutation = trpc.dishwasher.resume.useMutation

/** Generated alias around `trpc.dishwasher.stop.useMutation`. */
export const useDishwasherStop: typeof trpc.dishwasher.stop.useMutation = trpc.dishwasher.stop.useMutation

/** Generated alias around `trpc.dishwasher.setProgram.useMutation`. */
export const useDishwasherSetProgram: typeof trpc.dishwasher.setProgram.useMutation = trpc.dishwasher.setProgram.useMutation

/** Generated alias around `trpc.dishwasher.setPower.useMutation`. */
export const useDishwasherSetPower: typeof trpc.dishwasher.setPower.useMutation = trpc.dishwasher.setPower.useMutation

/** Generated alias around `trpc.dishwasher.setHalfLoad.useMutation`. */
export const useDishwasherSetHalfLoad: typeof trpc.dishwasher.setHalfLoad.useMutation = trpc.dishwasher.setHalfLoad.useMutation

/** Generated alias around `trpc.dishwasher.setHygienePlus.useMutation`. */
export const useDishwasherSetHygienePlus: typeof trpc.dishwasher.setHygienePlus.useMutation = trpc.dishwasher.setHygienePlus.useMutation

/** Generated alias around `trpc.dishwasher.setExtraDry.useMutation`. */
export const useDishwasherSetExtraDry: typeof trpc.dishwasher.setExtraDry.useMutation = trpc.dishwasher.setExtraDry.useMutation

/** Generated alias around `trpc.dishwasher.setIntensiveZone.useMutation`. */
export const useDishwasherSetIntensiveZone: typeof trpc.dishwasher.setIntensiveZone.useMutation = trpc.dishwasher.setIntensiveZone.useMutation

/** Generated alias around `trpc.dishwasher.setVarioSpeedPlus.useMutation`. */
export const useDishwasherSetVarioSpeedPlus: typeof trpc.dishwasher.setVarioSpeedPlus.useMutation = trpc.dishwasher.setVarioSpeedPlus.useMutation

/** Generated alias around `trpc.dishwasher.setChildLock.useMutation`. */
export const useDishwasherSetChildLock: typeof trpc.dishwasher.setChildLock.useMutation = trpc.dishwasher.setChildLock.useMutation

/** Generated alias around `trpc.dishwasher.setOption.useMutation`. */
export const useDishwasherSetOption: typeof trpc.dishwasher.setOption.useMutation = trpc.dishwasher.setOption.useMutation

/** Generated alias around `trpc.dishwasher.getOptions.useQuery`. */
export const useDishwasherGetOptions: typeof trpc.dishwasher.getOptions.useQuery = trpc.dishwasher.getOptions.useQuery

/** Generated alias around `trpc.dishwasher.getStatus.useQuery`. */
export const useDishwasherGetStatus: typeof trpc.dishwasher.getStatus.useQuery = trpc.dishwasher.getStatus.useQuery

/** Generated alias around `trpc.displayPalette.getPalette.useQuery`. */
export const useDisplayPaletteGetPalette: typeof trpc.displayPalette.getPalette.useQuery = trpc.displayPalette.getPalette.useQuery

/** Generated alias around `trpc.displayPalette.listPresets.useQuery`. */
export const useDisplayPaletteListPresets: typeof trpc.displayPalette.listPresets.useQuery = trpc.displayPalette.listPresets.useQuery

/** Generated alias around `trpc.displayPalette.setPalette.useMutation`. */
export const useDisplayPaletteSetPalette: typeof trpc.displayPalette.setPalette.useMutation = trpc.displayPalette.setPalette.useMutation

/** Generated alias around `trpc.doorbell.getStatus.useQuery`. */
export const useDoorbellGetStatus: typeof trpc.doorbell.getStatus.useQuery = trpc.doorbell.getStatus.useQuery

/** Generated alias around `trpc.enumSensor.getStatus.useQuery`. */
export const useEnumSensorGetStatus: typeof trpc.enumSensor.getStatus.useQuery = trpc.enumSensor.getStatus.useQuery

/** Generated alias around `trpc.eventEmitter.getStatus.useQuery`. */
export const useEventEmitterGetStatus: typeof trpc.eventEmitter.getStatus.useQuery = trpc.eventEmitter.getStatus.useQuery

/** Generated alias around `trpc.faceGallery.listIdentities.useQuery`. */
export const useFaceGalleryListIdentities: typeof trpc.faceGallery.listIdentities.useQuery = trpc.faceGallery.listIdentities.useQuery

/** Generated alias around `trpc.faceGallery.createIdentity.useMutation`. */
export const useFaceGalleryCreateIdentity: typeof trpc.faceGallery.createIdentity.useMutation = trpc.faceGallery.createIdentity.useMutation

/** Generated alias around `trpc.faceGallery.renameIdentity.useMutation`. */
export const useFaceGalleryRenameIdentity: typeof trpc.faceGallery.renameIdentity.useMutation = trpc.faceGallery.renameIdentity.useMutation

/** Generated alias around `trpc.faceGallery.deleteIdentity.useMutation`. */
export const useFaceGalleryDeleteIdentity: typeof trpc.faceGallery.deleteIdentity.useMutation = trpc.faceGallery.deleteIdentity.useMutation

/** Generated alias around `trpc.faceGallery.listIdentitySamples.useQuery`. */
export const useFaceGalleryListIdentitySamples: typeof trpc.faceGallery.listIdentitySamples.useQuery = trpc.faceGallery.listIdentitySamples.useQuery

/** Generated alias around `trpc.faceGallery.auditIdentitySamples.useQuery`. */
export const useFaceGalleryAuditIdentitySamples: typeof trpc.faceGallery.auditIdentitySamples.useQuery = trpc.faceGallery.auditIdentitySamples.useQuery

/** Generated alias around `trpc.faceGallery.removeSample.useMutation`. */
export const useFaceGalleryRemoveSample: typeof trpc.faceGallery.removeSample.useMutation = trpc.faceGallery.removeSample.useMutation

/** Generated alias around `trpc.faceGallery.listRecentFaces.useQuery`. */
export const useFaceGalleryListRecentFaces: typeof trpc.faceGallery.listRecentFaces.useQuery = trpc.faceGallery.listRecentFaces.useQuery

/** Generated alias around `trpc.faceGallery.getFaceByTrack.useQuery`. */
export const useFaceGalleryGetFaceByTrack: typeof trpc.faceGallery.getFaceByTrack.useQuery = trpc.faceGallery.getFaceByTrack.useQuery

/** Generated alias around `trpc.faceGallery.getFaceMedia.useQuery`. */
export const useFaceGalleryGetFaceMedia: typeof trpc.faceGallery.getFaceMedia.useQuery = trpc.faceGallery.getFaceMedia.useQuery

/** Generated alias around `trpc.faceGallery.assignFace.useMutation`. */
export const useFaceGalleryAssignFace: typeof trpc.faceGallery.assignFace.useMutation = trpc.faceGallery.assignFace.useMutation

/** Generated alias around `trpc.faceGallery.unassignFace.useMutation`. */
export const useFaceGalleryUnassignFace: typeof trpc.faceGallery.unassignFace.useMutation = trpc.faceGallery.unassignFace.useMutation

/** Generated alias around `trpc.faceGallery.deleteFace.useMutation`. */
export const useFaceGalleryDeleteFace: typeof trpc.faceGallery.deleteFace.useMutation = trpc.faceGallery.deleteFace.useMutation

/** Generated alias around `trpc.faceGallery.assignFaces.useMutation`. */
export const useFaceGalleryAssignFaces: typeof trpc.faceGallery.assignFaces.useMutation = trpc.faceGallery.assignFaces.useMutation

/** Generated alias around `trpc.faceGallery.unassignFaces.useMutation`. */
export const useFaceGalleryUnassignFaces: typeof trpc.faceGallery.unassignFaces.useMutation = trpc.faceGallery.unassignFaces.useMutation

/** Generated alias around `trpc.faceGallery.suggestFaceClusters.useQuery`. */
export const useFaceGallerySuggestFaceClusters: typeof trpc.faceGallery.suggestFaceClusters.useQuery = trpc.faceGallery.suggestFaceClusters.useQuery

/** Generated alias around `trpc.fanControl.setPercentage.useMutation`. */
export const useFanControlSetPercentage: typeof trpc.fanControl.setPercentage.useMutation = trpc.fanControl.setPercentage.useMutation

/** Generated alias around `trpc.fanControl.setPreset.useMutation`. */
export const useFanControlSetPreset: typeof trpc.fanControl.setPreset.useMutation = trpc.fanControl.setPreset.useMutation

/** Generated alias around `trpc.fanControl.setDirection.useMutation`. */
export const useFanControlSetDirection: typeof trpc.fanControl.setDirection.useMutation = trpc.fanControl.setDirection.useMutation

/** Generated alias around `trpc.fanControl.setOscillating.useMutation`. */
export const useFanControlSetOscillating: typeof trpc.fanControl.setOscillating.useMutation = trpc.fanControl.setOscillating.useMutation

/** Generated alias around `trpc.fanControl.getStatus.useQuery`. */
export const useFanControlGetStatus: typeof trpc.fanControl.getStatus.useQuery = trpc.fanControl.getStatus.useQuery

/** Generated alias around `trpc.featureProbe.getStatus.useQuery`. */
export const useFeatureProbeGetStatus: typeof trpc.featureProbe.getStatus.useQuery = trpc.featureProbe.getStatus.useQuery

/** Generated alias around `trpc.flood.getStatus.useQuery`. */
export const useFloodGetStatus: typeof trpc.flood.getStatus.useQuery = trpc.flood.getStatus.useQuery

/** Generated alias around `trpc.gas.getStatus.useQuery`. */
export const useGasGetStatus: typeof trpc.gas.getStatus.useQuery = trpc.gas.getStatus.useQuery

/** Generated alias around `trpc.groupCommands.getStatus.useQuery`. */
export const useGroupCommandsGetStatus: typeof trpc.groupCommands.getStatus.useQuery = trpc.groupCommands.getStatus.useQuery

/** Generated alias around `trpc.groupStatus.getStatus.useQuery`. */
export const useGroupStatusGetStatus: typeof trpc.groupStatus.getStatus.useQuery = trpc.groupStatus.getStatus.useQuery

/** Generated alias around `trpc.heatingValve.getStatus.useQuery`. */
export const useHeatingValveGetStatus: typeof trpc.heatingValve.getStatus.useQuery = trpc.heatingValve.getStatus.useQuery

/** Generated alias around `trpc.humidifier.setOn.useMutation`. */
export const useHumidifierSetOn: typeof trpc.humidifier.setOn.useMutation = trpc.humidifier.setOn.useMutation

/** Generated alias around `trpc.humidifier.setTargetHumidity.useMutation`. */
export const useHumidifierSetTargetHumidity: typeof trpc.humidifier.setTargetHumidity.useMutation = trpc.humidifier.setTargetHumidity.useMutation

/** Generated alias around `trpc.humidifier.setMode.useMutation`. */
export const useHumidifierSetMode: typeof trpc.humidifier.setMode.useMutation = trpc.humidifier.setMode.useMutation

/** Generated alias around `trpc.humidifier.getStatus.useQuery`. */
export const useHumidifierGetStatus: typeof trpc.humidifier.getStatus.useQuery = trpc.humidifier.getStatus.useQuery

/** Generated alias around `trpc.humiditySensor.getStatus.useQuery`. */
export const useHumiditySensorGetStatus: typeof trpc.humiditySensor.getStatus.useQuery = trpc.humiditySensor.getStatus.useQuery

/** Generated alias around `trpc.image.getStatus.useQuery`. */
export const useImageGetStatus: typeof trpc.image.getStatus.useQuery = trpc.image.getStatus.useQuery

/** Generated alias around `trpc.imageSettings.getOptions.useQuery`. */
export const useImageSettingsGetOptions: typeof trpc.imageSettings.getOptions.useQuery = trpc.imageSettings.getOptions.useQuery

/** Generated alias around `trpc.imageSettings.setSettings.useMutation`. */
export const useImageSettingsSetSettings: typeof trpc.imageSettings.setSettings.useMutation = trpc.imageSettings.setSettings.useMutation

/** Generated alias around `trpc.imageSettings.getStatus.useQuery`. */
export const useImageSettingsGetStatus: typeof trpc.imageSettings.getStatus.useQuery = trpc.imageSettings.getStatus.useQuery

/** Generated alias around `trpc.integrations.list.useQuery`. */
export const useIntegrationsList: typeof trpc.integrations.list.useQuery = trpc.integrations.list.useQuery

/** Generated alias around `trpc.integrations.get.useQuery`. */
export const useIntegrationsGet: typeof trpc.integrations.get.useQuery = trpc.integrations.get.useQuery

/** Generated alias around `trpc.integrations.getByAddonId.useQuery`. */
export const useIntegrationsGetByAddonId: typeof trpc.integrations.getByAddonId.useQuery = trpc.integrations.getByAddonId.useQuery

/** Generated alias around `trpc.integrations.create.useMutation`. */
export const useIntegrationsCreate: typeof trpc.integrations.create.useMutation = trpc.integrations.create.useMutation

/** Generated alias around `trpc.integrations.update.useMutation`. */
export const useIntegrationsUpdate: typeof trpc.integrations.update.useMutation = trpc.integrations.update.useMutation

/** Generated alias around `trpc.integrations.delete.useMutation`. */
export const useIntegrationsDelete: typeof trpc.integrations.delete.useMutation = trpc.integrations.delete.useMutation

/** Generated alias around `trpc.integrations.getSettings.useQuery`. */
export const useIntegrationsGetSettings: typeof trpc.integrations.getSettings.useQuery = trpc.integrations.getSettings.useQuery

/** Generated alias around `trpc.integrations.setSettings.useMutation`. */
export const useIntegrationsSetSettings: typeof trpc.integrations.setSettings.useMutation = trpc.integrations.setSettings.useMutation

/** Generated alias around `trpc.integrations.getAvailableTypes.useQuery`. */
export const useIntegrationsGetAvailableTypes: typeof trpc.integrations.getAvailableTypes.useQuery = trpc.integrations.getAvailableTypes.useQuery

/** Generated alias around `trpc.integrations.testConnection.useMutation`. */
export const useIntegrationsTestConnection: typeof trpc.integrations.testConnection.useMutation = trpc.integrations.testConnection.useMutation

/** Generated alias around `trpc.intercom.startSession.useMutation`. */
export const useIntercomStartSession: typeof trpc.intercom.startSession.useMutation = trpc.intercom.startSession.useMutation

/** Generated alias around `trpc.intercom.handleAnswer.useMutation`. */
export const useIntercomHandleAnswer: typeof trpc.intercom.handleAnswer.useMutation = trpc.intercom.handleAnswer.useMutation

/** Generated alias around `trpc.intercom.stopSession.useMutation`. */
export const useIntercomStopSession: typeof trpc.intercom.stopSession.useMutation = trpc.intercom.stopSession.useMutation

/** Generated alias around `trpc.intercom.startTalkSession.useMutation`. */
export const useIntercomStartTalkSession: typeof trpc.intercom.startTalkSession.useMutation = trpc.intercom.startTalkSession.useMutation

/** Generated alias around `trpc.intercom.pushTalkAudio.useMutation`. */
export const useIntercomPushTalkAudio: typeof trpc.intercom.pushTalkAudio.useMutation = trpc.intercom.pushTalkAudio.useMutation

/** Generated alias around `trpc.intercom.endTalkSession.useMutation`. */
export const useIntercomEndTalkSession: typeof trpc.intercom.endTalkSession.useMutation = trpc.intercom.endTalkSession.useMutation

/** Generated alias around `trpc.intercom.getStatus.useQuery`. */
export const useIntercomGetStatus: typeof trpc.intercom.getStatus.useQuery = trpc.intercom.getStatus.useQuery

/** Generated alias around `trpc.keychainAdmin.status.useQuery`. */
export const useKeychainAdminStatus: typeof trpc.keychainAdmin.status.useQuery = trpc.keychainAdmin.status.useQuery

/** Generated alias around `trpc.keychainAdmin.listSecrets.useQuery`. */
export const useKeychainAdminListSecrets: typeof trpc.keychainAdmin.listSecrets.useQuery = trpc.keychainAdmin.listSecrets.useQuery

/** Generated alias around `trpc.keychainAdmin.listAudit.useQuery`. */
export const useKeychainAdminListAudit: typeof trpc.keychainAdmin.listAudit.useQuery = trpc.keychainAdmin.listAudit.useQuery

/** Generated alias around `trpc.keychainAdmin.reveal.useMutation`. */
export const useKeychainAdminReveal: typeof trpc.keychainAdmin.reveal.useMutation = trpc.keychainAdmin.reveal.useMutation

/** Generated alias around `trpc.keychainAdmin.setSystemSecret.useMutation`. */
export const useKeychainAdminSetSystemSecret: typeof trpc.keychainAdmin.setSystemSecret.useMutation = trpc.keychainAdmin.setSystemSecret.useMutation

/** Generated alias around `trpc.keychainAdmin.importSecret.useMutation`. */
export const useKeychainAdminImportSecret: typeof trpc.keychainAdmin.importSecret.useMutation = trpc.keychainAdmin.importSecret.useMutation

/** Generated alias around `trpc.keychainAdmin.deleteOrphans.useMutation`. */
export const useKeychainAdminDeleteOrphans: typeof trpc.keychainAdmin.deleteOrphans.useMutation = trpc.keychainAdmin.deleteOrphans.useMutation

/** Generated alias around `trpc.keychainAdmin.rotateMasterKey.useMutation`. */
export const useKeychainAdminRotateMasterKey: typeof trpc.keychainAdmin.rotateMasterKey.useMutation = trpc.keychainAdmin.rotateMasterKey.useMutation

/** Generated alias around `trpc.keychainAdmin.purgeRetiredKeys.useMutation`. */
export const useKeychainAdminPurgeRetiredKeys: typeof trpc.keychainAdmin.purgeRetiredKeys.useMutation = trpc.keychainAdmin.purgeRetiredKeys.useMutation

/** Generated alias around `trpc.keychainAdmin.downloadRecoveryKey.useMutation`. */
export const useKeychainAdminDownloadRecoveryKey: typeof trpc.keychainAdmin.downloadRecoveryKey.useMutation = trpc.keychainAdmin.downloadRecoveryKey.useMutation

/** Generated alias around `trpc.keychainAdmin.resetKeychain.useMutation`. */
export const useKeychainAdminResetKeychain: typeof trpc.keychainAdmin.resetKeychain.useMutation = trpc.keychainAdmin.resetKeychain.useMutation

/** Generated alias around `trpc.keychainAdmin.resetReport.useQuery`. */
export const useKeychainAdminResetReport: typeof trpc.keychainAdmin.resetReport.useQuery = trpc.keychainAdmin.resetReport.useQuery

/** Generated alias around `trpc.keychainAdmin.acknowledgeReset.useMutation`. */
export const useKeychainAdminAcknowledgeReset: typeof trpc.keychainAdmin.acknowledgeReset.useMutation = trpc.keychainAdmin.acknowledgeReset.useMutation

/** Generated alias around `trpc.lawnMowerControl.startMowing.useMutation`. */
export const useLawnMowerControlStartMowing: typeof trpc.lawnMowerControl.startMowing.useMutation = trpc.lawnMowerControl.startMowing.useMutation

/** Generated alias around `trpc.lawnMowerControl.pause.useMutation`. */
export const useLawnMowerControlPause: typeof trpc.lawnMowerControl.pause.useMutation = trpc.lawnMowerControl.pause.useMutation

/** Generated alias around `trpc.lawnMowerControl.dock.useMutation`. */
export const useLawnMowerControlDock: typeof trpc.lawnMowerControl.dock.useMutation = trpc.lawnMowerControl.dock.useMutation

/** Generated alias around `trpc.lawnMowerControl.getStatus.useQuery`. */
export const useLawnMowerControlGetStatus: typeof trpc.lawnMowerControl.getStatus.useQuery = trpc.lawnMowerControl.getStatus.useQuery

/** Generated alias around `trpc.llm.generate.useMutation`. */
export const useLlmGenerate: typeof trpc.llm.generate.useMutation = trpc.llm.generate.useMutation

/** Generated alias around `trpc.llm.generateVision.useMutation`. */
export const useLlmGenerateVision: typeof trpc.llm.generateVision.useMutation = trpc.llm.generateVision.useMutation

/** Generated alias around `trpc.llm.cancel.useMutation`. */
export const useLlmCancel: typeof trpc.llm.cancel.useMutation = trpc.llm.cancel.useMutation

/** Generated alias around `trpc.llm.listProfileKinds.useQuery`. */
export const useLlmListProfileKinds: typeof trpc.llm.listProfileKinds.useQuery = trpc.llm.listProfileKinds.useQuery

/** Generated alias around `trpc.llm.listProfiles.useQuery`. */
export const useLlmListProfiles: typeof trpc.llm.listProfiles.useQuery = trpc.llm.listProfiles.useQuery

/** Generated alias around `trpc.llm.upsertProfile.useMutation`. */
export const useLlmUpsertProfile: typeof trpc.llm.upsertProfile.useMutation = trpc.llm.upsertProfile.useMutation

/** Generated alias around `trpc.llm.migrateRawSecrets.useMutation`. */
export const useLlmMigrateRawSecrets: typeof trpc.llm.migrateRawSecrets.useMutation = trpc.llm.migrateRawSecrets.useMutation

/** Generated alias around `trpc.llm.deleteProfile.useMutation`. */
export const useLlmDeleteProfile: typeof trpc.llm.deleteProfile.useMutation = trpc.llm.deleteProfile.useMutation

/** Generated alias around `trpc.llm.testProfile.useMutation`. */
export const useLlmTestProfile: typeof trpc.llm.testProfile.useMutation = trpc.llm.testProfile.useMutation

/** Generated alias around `trpc.llm.listModels.useMutation`. */
export const useLlmListModels: typeof trpc.llm.listModels.useMutation = trpc.llm.listModels.useMutation

/** Generated alias around `trpc.llm.getDefaults.useQuery`. */
export const useLlmGetDefaults: typeof trpc.llm.getDefaults.useQuery = trpc.llm.getDefaults.useQuery

/** Generated alias around `trpc.llm.setDefault.useMutation`. */
export const useLlmSetDefault: typeof trpc.llm.setDefault.useMutation = trpc.llm.setDefault.useMutation

/** Generated alias around `trpc.llm.getUsage.useQuery`. */
export const useLlmGetUsage: typeof trpc.llm.getUsage.useQuery = trpc.llm.getUsage.useQuery

/** Generated alias around `trpc.llm.listModelCatalog.useQuery`. */
export const useLlmListModelCatalog: typeof trpc.llm.listModelCatalog.useQuery = trpc.llm.listModelCatalog.useQuery

/** Generated alias around `trpc.llm.listRuntimeNodes.useQuery`. */
export const useLlmListRuntimeNodes: typeof trpc.llm.listRuntimeNodes.useQuery = trpc.llm.listRuntimeNodes.useQuery

/** Generated alias around `trpc.llm.listNodeModels.useQuery`. */
export const useLlmListNodeModels: typeof trpc.llm.listNodeModels.useQuery = trpc.llm.listNodeModels.useQuery

/** Generated alias around `trpc.llm.resolveModelRef.useMutation`. */
export const useLlmResolveModelRef: typeof trpc.llm.resolveModelRef.useMutation = trpc.llm.resolveModelRef.useMutation

/** Generated alias around `trpc.llm.installModel.useMutation`. */
export const useLlmInstallModel: typeof trpc.llm.installModel.useMutation = trpc.llm.installModel.useMutation

/** Generated alias around `trpc.llm.deleteModel.useMutation`. */
export const useLlmDeleteModel: typeof trpc.llm.deleteModel.useMutation = trpc.llm.deleteModel.useMutation

/** Generated alias around `trpc.llm.getRuntimeStatus.useQuery`. */
export const useLlmGetRuntimeStatus: typeof trpc.llm.getRuntimeStatus.useQuery = trpc.llm.getRuntimeStatus.useQuery

/** Generated alias around `trpc.llm.startRuntime.useMutation`. */
export const useLlmStartRuntime: typeof trpc.llm.startRuntime.useMutation = trpc.llm.startRuntime.useMutation

/** Generated alias around `trpc.llm.stopRuntime.useMutation`. */
export const useLlmStopRuntime: typeof trpc.llm.stopRuntime.useMutation = trpc.llm.stopRuntime.useMutation

/** Generated alias around `trpc.localNetwork.list.useQuery`. */
export const useLocalNetworkList: typeof trpc.localNetwork.list.useQuery = trpc.localNetwork.list.useQuery

/** Generated alias around `trpc.localNetwork.getPreferred.useQuery`. */
export const useLocalNetworkGetPreferred: typeof trpc.localNetwork.getPreferred.useQuery = trpc.localNetwork.getPreferred.useQuery

/** Generated alias around `trpc.localNetwork.getConnectionEndpoints.useQuery`. */
export const useLocalNetworkGetConnectionEndpoints: typeof trpc.localNetwork.getConnectionEndpoints.useQuery = trpc.localNetwork.getConnectionEndpoints.useQuery

/** Generated alias around `trpc.localNetwork.getNotificationEndpoint.useQuery`. */
export const useLocalNetworkGetNotificationEndpoint: typeof trpc.localNetwork.getNotificationEndpoint.useQuery = trpc.localNetwork.getNotificationEndpoint.useQuery

/** Generated alias around `trpc.localNetwork.setNotificationEndpoint.useMutation`. */
export const useLocalNetworkSetNotificationEndpoint: typeof trpc.localNetwork.setNotificationEndpoint.useMutation = trpc.localNetwork.setNotificationEndpoint.useMutation

/** Generated alias around `trpc.localNetwork.getViewerEndpoints.useQuery`. */
export const useLocalNetworkGetViewerEndpoints: typeof trpc.localNetwork.getViewerEndpoints.useQuery = trpc.localNetwork.getViewerEndpoints.useQuery

/** Generated alias around `trpc.localNetwork.setViewerEndpoints.useMutation`. */
export const useLocalNetworkSetViewerEndpoints: typeof trpc.localNetwork.setViewerEndpoints.useMutation = trpc.localNetwork.setViewerEndpoints.useMutation

/** Generated alias around `trpc.localNetwork.getAddresses.useQuery`. */
export const useLocalNetworkGetAddresses: typeof trpc.localNetwork.getAddresses.useQuery = trpc.localNetwork.getAddresses.useQuery

/** Generated alias around `trpc.localNetwork.addCustomAddress.useMutation`. */
export const useLocalNetworkAddCustomAddress: typeof trpc.localNetwork.addCustomAddress.useMutation = trpc.localNetwork.addCustomAddress.useMutation

/** Generated alias around `trpc.localNetwork.removeCustomAddress.useMutation`. */
export const useLocalNetworkRemoveCustomAddress: typeof trpc.localNetwork.removeCustomAddress.useMutation = trpc.localNetwork.removeCustomAddress.useMutation

/** Generated alias around `trpc.localNetwork.setAddressRole.useMutation`. */
export const useLocalNetworkSetAddressRole: typeof trpc.localNetwork.setAddressRole.useMutation = trpc.localNetwork.setAddressRole.useMutation

/** Generated alias around `trpc.localNetwork.getHubAddresses.useQuery`. */
export const useLocalNetworkGetHubAddresses: typeof trpc.localNetwork.getHubAddresses.useQuery = trpc.localNetwork.getHubAddresses.useQuery

/** Generated alias around `trpc.localNetwork.getAllowedAddresses.useQuery`. */
export const useLocalNetworkGetAllowedAddresses: typeof trpc.localNetwork.getAllowedAddresses.useQuery = trpc.localNetwork.getAllowedAddresses.useQuery

/** Generated alias around `trpc.localNetwork.setAllowedAddresses.useMutation`. */
export const useLocalNetworkSetAllowedAddresses: typeof trpc.localNetwork.setAllowedAddresses.useMutation = trpc.localNetwork.setAllowedAddresses.useMutation

/** Generated alias around `trpc.localNetwork.resetAllowlistToBestMatch.useMutation`. */
export const useLocalNetworkResetAllowlistToBestMatch: typeof trpc.localNetwork.resetAllowlistToBestMatch.useMutation = trpc.localNetwork.resetAllowlistToBestMatch.useMutation

/** Generated alias around `trpc.localNetwork.getTlsStatus.useQuery`. */
export const useLocalNetworkGetTlsStatus: typeof trpc.localNetwork.getTlsStatus.useQuery = trpc.localNetwork.getTlsStatus.useQuery

/** Generated alias around `trpc.localNetwork.regenerateCertificate.useMutation`. */
export const useLocalNetworkRegenerateCertificate: typeof trpc.localNetwork.regenerateCertificate.useMutation = trpc.localNetwork.regenerateCertificate.useMutation

/** Generated alias around `trpc.localNetwork.uploadCertificate.useMutation`. */
export const useLocalNetworkUploadCertificate: typeof trpc.localNetwork.uploadCertificate.useMutation = trpc.localNetwork.uploadCertificate.useMutation

/** Generated alias around `trpc.localNetwork.downloadCa.useQuery`. */
export const useLocalNetworkDownloadCa: typeof trpc.localNetwork.downloadCa.useQuery = trpc.localNetwork.downloadCa.useQuery

/** Generated alias around `trpc.localNetwork.useStoredUploadedCertificate.useMutation`. */
export const useLocalNetworkUseStoredUploadedCertificate: typeof trpc.localNetwork.useStoredUploadedCertificate.useMutation = trpc.localNetwork.useStoredUploadedCertificate.useMutation

/** Generated alias around `trpc.localNetwork.revertToGeneratedCertificate.useMutation`. */
export const useLocalNetworkRevertToGeneratedCertificate: typeof trpc.localNetwork.revertToGeneratedCertificate.useMutation = trpc.localNetwork.revertToGeneratedCertificate.useMutation

/** Generated alias around `trpc.lockControl.lock.useMutation`. */
export const useLockControlLock: typeof trpc.lockControl.lock.useMutation = trpc.lockControl.lock.useMutation

/** Generated alias around `trpc.lockControl.unlock.useMutation`. */
export const useLockControlUnlock: typeof trpc.lockControl.unlock.useMutation = trpc.lockControl.unlock.useMutation

/** Generated alias around `trpc.lockControl.open.useMutation`. */
export const useLockControlOpen: typeof trpc.lockControl.open.useMutation = trpc.lockControl.open.useMutation

/** Generated alias around `trpc.lockControl.getStatus.useQuery`. */
export const useLockControlGetStatus: typeof trpc.lockControl.getStatus.useQuery = trpc.lockControl.getStatus.useQuery

/** Generated alias around `trpc.mediaPlayer.play.useMutation`. */
export const useMediaPlayerPlay: typeof trpc.mediaPlayer.play.useMutation = trpc.mediaPlayer.play.useMutation

/** Generated alias around `trpc.mediaPlayer.pause.useMutation`. */
export const useMediaPlayerPause: typeof trpc.mediaPlayer.pause.useMutation = trpc.mediaPlayer.pause.useMutation

/** Generated alias around `trpc.mediaPlayer.stop.useMutation`. */
export const useMediaPlayerStop: typeof trpc.mediaPlayer.stop.useMutation = trpc.mediaPlayer.stop.useMutation

/** Generated alias around `trpc.mediaPlayer.next.useMutation`. */
export const useMediaPlayerNext: typeof trpc.mediaPlayer.next.useMutation = trpc.mediaPlayer.next.useMutation

/** Generated alias around `trpc.mediaPlayer.previous.useMutation`. */
export const useMediaPlayerPrevious: typeof trpc.mediaPlayer.previous.useMutation = trpc.mediaPlayer.previous.useMutation

/** Generated alias around `trpc.mediaPlayer.seek.useMutation`. */
export const useMediaPlayerSeek: typeof trpc.mediaPlayer.seek.useMutation = trpc.mediaPlayer.seek.useMutation

/** Generated alias around `trpc.mediaPlayer.setVolume.useMutation`. */
export const useMediaPlayerSetVolume: typeof trpc.mediaPlayer.setVolume.useMutation = trpc.mediaPlayer.setVolume.useMutation

/** Generated alias around `trpc.mediaPlayer.setMute.useMutation`. */
export const useMediaPlayerSetMute: typeof trpc.mediaPlayer.setMute.useMutation = trpc.mediaPlayer.setMute.useMutation

/** Generated alias around `trpc.mediaPlayer.setShuffle.useMutation`. */
export const useMediaPlayerSetShuffle: typeof trpc.mediaPlayer.setShuffle.useMutation = trpc.mediaPlayer.setShuffle.useMutation

/** Generated alias around `trpc.mediaPlayer.setRepeat.useMutation`. */
export const useMediaPlayerSetRepeat: typeof trpc.mediaPlayer.setRepeat.useMutation = trpc.mediaPlayer.setRepeat.useMutation

/** Generated alias around `trpc.mediaPlayer.selectSource.useMutation`. */
export const useMediaPlayerSelectSource: typeof trpc.mediaPlayer.selectSource.useMutation = trpc.mediaPlayer.selectSource.useMutation

/** Generated alias around `trpc.mediaPlayer.playMedia.useMutation`. */
export const useMediaPlayerPlayMedia: typeof trpc.mediaPlayer.playMedia.useMutation = trpc.mediaPlayer.playMedia.useMutation

/** Generated alias around `trpc.mediaPlayer.getStatus.useQuery`. */
export const useMediaPlayerGetStatus: typeof trpc.mediaPlayer.getStatus.useQuery = trpc.mediaPlayer.getStatus.useQuery

/** Generated alias around `trpc.meshNetwork.getStatus.useQuery`. */
export const useMeshNetworkGetStatus: typeof trpc.meshNetwork.getStatus.useQuery = trpc.meshNetwork.getStatus.useQuery

/** Generated alias around `trpc.meshNetwork.join.useMutation`. */
export const useMeshNetworkJoin: typeof trpc.meshNetwork.join.useMutation = trpc.meshNetwork.join.useMutation

/** Generated alias around `trpc.meshNetwork.startLogin.useMutation`. */
export const useMeshNetworkStartLogin: typeof trpc.meshNetwork.startLogin.useMutation = trpc.meshNetwork.startLogin.useMutation

/** Generated alias around `trpc.meshNetwork.leave.useMutation`. */
export const useMeshNetworkLeave: typeof trpc.meshNetwork.leave.useMutation = trpc.meshNetwork.leave.useMutation

/** Generated alias around `trpc.meshNetwork.logout.useMutation`. */
export const useMeshNetworkLogout: typeof trpc.meshNetwork.logout.useMutation = trpc.meshNetwork.logout.useMutation

/** Generated alias around `trpc.meshNetwork.listPeers.useQuery`. */
export const useMeshNetworkListPeers: typeof trpc.meshNetwork.listPeers.useQuery = trpc.meshNetwork.listPeers.useQuery

/** Generated alias around `trpc.meshNetwork.testConnection.useMutation`. */
export const useMeshNetworkTestConnection: typeof trpc.meshNetwork.testConnection.useMutation = trpc.meshNetwork.testConnection.useMutation

/** Generated alias around `trpc.metricsProvider.collectSnapshot.useQuery`. */
export const useMetricsProviderCollectSnapshot: typeof trpc.metricsProvider.collectSnapshot.useQuery = trpc.metricsProvider.collectSnapshot.useQuery

/** Generated alias around `trpc.metricsProvider.getCached.useQuery`. */
export const useMetricsProviderGetCached: typeof trpc.metricsProvider.getCached.useQuery = trpc.metricsProvider.getCached.useQuery

/** Generated alias around `trpc.metricsProvider.getCurrent.useQuery`. */
export const useMetricsProviderGetCurrent: typeof trpc.metricsProvider.getCurrent.useQuery = trpc.metricsProvider.getCurrent.useQuery

/** Generated alias around `trpc.metricsProvider.getDiskSpace.useQuery`. */
export const useMetricsProviderGetDiskSpace: typeof trpc.metricsProvider.getDiskSpace.useQuery = trpc.metricsProvider.getDiskSpace.useQuery

/** Generated alias around `trpc.metricsProvider.getGpuInfo.useQuery`. */
export const useMetricsProviderGetGpuInfo: typeof trpc.metricsProvider.getGpuInfo.useQuery = trpc.metricsProvider.getGpuInfo.useQuery

/** Generated alias around `trpc.metricsProvider.getCpuTemperature.useQuery`. */
export const useMetricsProviderGetCpuTemperature: typeof trpc.metricsProvider.getCpuTemperature.useQuery = trpc.metricsProvider.getCpuTemperature.useQuery

/** Generated alias around `trpc.metricsProvider.getProcessStats.useQuery`. */
export const useMetricsProviderGetProcessStats: typeof trpc.metricsProvider.getProcessStats.useQuery = trpc.metricsProvider.getProcessStats.useQuery

/** Generated alias around `trpc.metricsProvider.listAddonInstances.useQuery`. */
export const useMetricsProviderListAddonInstances: typeof trpc.metricsProvider.listAddonInstances.useQuery = trpc.metricsProvider.listAddonInstances.useQuery

/** Generated alias around `trpc.metricsProvider.getAddonStats.useQuery`. */
export const useMetricsProviderGetAddonStats: typeof trpc.metricsProvider.getAddonStats.useQuery = trpc.metricsProvider.getAddonStats.useQuery

/** Generated alias around `trpc.metricsProvider.listNodeProcesses.useQuery`. */
export const useMetricsProviderListNodeProcesses: typeof trpc.metricsProvider.listNodeProcesses.useQuery = trpc.metricsProvider.listNodeProcesses.useQuery

/** Generated alias around `trpc.metricsProvider.getLoadSeries.useQuery`. */
export const useMetricsProviderGetLoadSeries: typeof trpc.metricsProvider.getLoadSeries.useQuery = trpc.metricsProvider.getLoadSeries.useQuery

/** Generated alias around `trpc.motion.isDetected.useQuery`. */
export const useMotionIsDetected: typeof trpc.motion.isDetected.useQuery = trpc.motion.isDetected.useQuery

/** Generated alias around `trpc.motion.getStatus.useQuery`. */
export const useMotionGetStatus: typeof trpc.motion.getStatus.useQuery = trpc.motion.getStatus.useQuery

/** Generated alias around `trpc.motionDetection.analyze.useMutation`. */
export const useMotionDetectionAnalyze: typeof trpc.motionDetection.analyze.useMutation = trpc.motionDetection.analyze.useMutation

/** Generated alias around `trpc.motionDetection.removeCamera.useMutation`. */
export const useMotionDetectionRemoveCamera: typeof trpc.motionDetection.removeCamera.useMutation = trpc.motionDetection.removeCamera.useMutation

/** Generated alias around `trpc.motionDetection.reset.useMutation`. */
export const useMotionDetectionReset: typeof trpc.motionDetection.reset.useMutation = trpc.motionDetection.reset.useMutation

/** Generated alias around `trpc.motionDetection.getDeviceSettingsContribution.useQuery`. */
export const useMotionDetectionGetDeviceSettingsContribution: typeof trpc.motionDetection.getDeviceSettingsContribution.useQuery = trpc.motionDetection.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.motionDetection.getDeviceLiveContribution.useQuery`. */
export const useMotionDetectionGetDeviceLiveContribution: typeof trpc.motionDetection.getDeviceLiveContribution.useQuery = trpc.motionDetection.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.motionDetection.applyDeviceSettingsPatch.useMutation`. */
export const useMotionDetectionApplyDeviceSettingsPatch: typeof trpc.motionDetection.applyDeviceSettingsPatch.useMutation = trpc.motionDetection.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.motionTrigger.setMotionTrigger.useMutation`. */
export const useMotionTriggerSetMotionTrigger: typeof trpc.motionTrigger.setMotionTrigger.useMutation = trpc.motionTrigger.setMotionTrigger.useMutation

/** Generated alias around `trpc.motionTrigger.getStatus.useQuery`. */
export const useMotionTriggerGetStatus: typeof trpc.motionTrigger.getStatus.useQuery = trpc.motionTrigger.getStatus.useQuery

/** Generated alias around `trpc.motionZones.getOptions.useQuery`. */
export const useMotionZonesGetOptions: typeof trpc.motionZones.getOptions.useQuery = trpc.motionZones.getOptions.useQuery

/** Generated alias around `trpc.motionZones.setZone.useMutation`. */
export const useMotionZonesSetZone: typeof trpc.motionZones.setZone.useMutation = trpc.motionZones.setZone.useMutation

/** Generated alias around `trpc.motionZones.getStatus.useQuery`. */
export const useMotionZonesGetStatus: typeof trpc.motionZones.getStatus.useQuery = trpc.motionZones.getStatus.useQuery

/** Generated alias around `trpc.mqttBroker.listBrokers.useQuery`. */
export const useMqttBrokerListBrokers: typeof trpc.mqttBroker.listBrokers.useQuery = trpc.mqttBroker.listBrokers.useQuery

/** Generated alias around `trpc.mqttBroker.getBrokerConfig.useQuery`. */
export const useMqttBrokerGetBrokerConfig: typeof trpc.mqttBroker.getBrokerConfig.useQuery = trpc.mqttBroker.getBrokerConfig.useQuery

/** Generated alias around `trpc.mqttBroker.addBroker.useMutation`. */
export const useMqttBrokerAddBroker: typeof trpc.mqttBroker.addBroker.useMutation = trpc.mqttBroker.addBroker.useMutation

/** Generated alias around `trpc.mqttBroker.removeBroker.useMutation`. */
export const useMqttBrokerRemoveBroker: typeof trpc.mqttBroker.removeBroker.useMutation = trpc.mqttBroker.removeBroker.useMutation

/** Generated alias around `trpc.mqttBroker.testConnection.useMutation`. */
export const useMqttBrokerTestConnection: typeof trpc.mqttBroker.testConnection.useMutation = trpc.mqttBroker.testConnection.useMutation

/** Generated alias around `trpc.mqttBroker.startEmbeddedBroker.useMutation`. */
export const useMqttBrokerStartEmbeddedBroker: typeof trpc.mqttBroker.startEmbeddedBroker.useMutation = trpc.mqttBroker.startEmbeddedBroker.useMutation

/** Generated alias around `trpc.mqttBroker.stopEmbeddedBroker.useMutation`. */
export const useMqttBrokerStopEmbeddedBroker: typeof trpc.mqttBroker.stopEmbeddedBroker.useMutation = trpc.mqttBroker.stopEmbeddedBroker.useMutation

/** Generated alias around `trpc.mqttBroker.getStatus.useQuery`. */
export const useMqttBrokerGetStatus: typeof trpc.mqttBroker.getStatus.useQuery = trpc.mqttBroker.getStatus.useQuery

/** Generated alias around `trpc.nativeObjectDetection.getOptions.useQuery`. */
export const useNativeObjectDetectionGetOptions: typeof trpc.nativeObjectDetection.getOptions.useQuery = trpc.nativeObjectDetection.getOptions.useQuery

/** Generated alias around `trpc.nativeObjectDetection.setSettings.useMutation`. */
export const useNativeObjectDetectionSetSettings: typeof trpc.nativeObjectDetection.setSettings.useMutation = trpc.nativeObjectDetection.setSettings.useMutation

/** Generated alias around `trpc.nativeObjectDetection.setEnabled.useMutation`. */
export const useNativeObjectDetectionSetEnabled: typeof trpc.nativeObjectDetection.setEnabled.useMutation = trpc.nativeObjectDetection.setEnabled.useMutation

/** Generated alias around `trpc.nativeObjectDetection.getStatus.useQuery`. */
export const useNativeObjectDetectionGetStatus: typeof trpc.nativeObjectDetection.getStatus.useQuery = trpc.nativeObjectDetection.getStatus.useQuery

/** Generated alias around `trpc.navigation.move.useMutation`. */
export const useNavigationMove: typeof trpc.navigation.move.useMutation = trpc.navigation.move.useMutation

/** Generated alias around `trpc.navigation.stop.useMutation`. */
export const useNavigationStop: typeof trpc.navigation.stop.useMutation = trpc.navigation.stop.useMutation

/** Generated alias around `trpc.navigation.goToPoint.useMutation`. */
export const useNavigationGoToPoint: typeof trpc.navigation.goToPoint.useMutation = trpc.navigation.goToPoint.useMutation

/** Generated alias around `trpc.navigation.listActions.useQuery`. */
export const useNavigationListActions: typeof trpc.navigation.listActions.useQuery = trpc.navigation.listActions.useQuery

/** Generated alias around `trpc.navigation.runAction.useMutation`. */
export const useNavigationRunAction: typeof trpc.navigation.runAction.useMutation = trpc.navigation.runAction.useMutation

/** Generated alias around `trpc.navigation.playSound.useMutation`. */
export const useNavigationPlaySound: typeof trpc.navigation.playSound.useMutation = trpc.navigation.playSound.useMutation

/** Generated alias around `trpc.navigation.setLightOn.useMutation`. */
export const useNavigationSetLightOn: typeof trpc.navigation.setLightOn.useMutation = trpc.navigation.setLightOn.useMutation

/** Generated alias around `trpc.navigation.setLightMode.useMutation`. */
export const useNavigationSetLightMode: typeof trpc.navigation.setLightMode.useMutation = trpc.navigation.setLightMode.useMutation

/** Generated alias around `trpc.navigation.setLightLevel.useMutation`. */
export const useNavigationSetLightLevel: typeof trpc.navigation.setLightLevel.useMutation = trpc.navigation.setLightLevel.useMutation

/** Generated alias around `trpc.navigation.getFeatures.useQuery`. */
export const useNavigationGetFeatures: typeof trpc.navigation.getFeatures.useQuery = trpc.navigation.getFeatures.useQuery

/** Generated alias around `trpc.navigation.getStatus.useQuery`. */
export const useNavigationGetStatus: typeof trpc.navigation.getStatus.useQuery = trpc.navigation.getStatus.useQuery

/** Generated alias around `trpc.networkAccess.start.useMutation`. */
export const useNetworkAccessStart: typeof trpc.networkAccess.start.useMutation = trpc.networkAccess.start.useMutation

/** Generated alias around `trpc.networkAccess.stop.useMutation`. */
export const useNetworkAccessStop: typeof trpc.networkAccess.stop.useMutation = trpc.networkAccess.stop.useMutation

/** Generated alias around `trpc.networkAccess.getEndpoint.useQuery`. */
export const useNetworkAccessGetEndpoint: typeof trpc.networkAccess.getEndpoint.useQuery = trpc.networkAccess.getEndpoint.useQuery

/** Generated alias around `trpc.networkAccess.getStatus.useQuery`. */
export const useNetworkAccessGetStatus: typeof trpc.networkAccess.getStatus.useQuery = trpc.networkAccess.getStatus.useQuery

/** Generated alias around `trpc.networkAccess.listEndpoints.useQuery`. */
export const useNetworkAccessListEndpoints: typeof trpc.networkAccess.listEndpoints.useQuery = trpc.networkAccess.listEndpoints.useQuery

/** Generated alias around `trpc.networkLink.getStatus.useQuery`. */
export const useNetworkLinkGetStatus: typeof trpc.networkLink.getStatus.useQuery = trpc.networkLink.getStatus.useQuery

/** Generated alias around `trpc.networkQuality.getDeviceStats.useQuery`. */
export const useNetworkQualityGetDeviceStats: typeof trpc.networkQuality.getDeviceStats.useQuery = trpc.networkQuality.getDeviceStats.useQuery

/** Generated alias around `trpc.networkQuality.getAllStats.useQuery`. */
export const useNetworkQualityGetAllStats: typeof trpc.networkQuality.getAllStats.useQuery = trpc.networkQuality.getAllStats.useQuery

/** Generated alias around `trpc.networkQuality.reportClientStats.useMutation`. */
export const useNetworkQualityReportClientStats: typeof trpc.networkQuality.reportClientStats.useMutation = trpc.networkQuality.reportClientStats.useMutation

/** Generated alias around `trpc.nodes.topology.useQuery`. */
export const useNodesTopology: typeof trpc.nodes.topology.useQuery = trpc.nodes.topology.useQuery

/** Generated alias around `trpc.nodes.directory.useQuery`. */
export const useNodesDirectory: typeof trpc.nodes.directory.useQuery = trpc.nodes.directory.useQuery

/** Generated alias around `trpc.nodes.deployAddon.useMutation`. */
export const useNodesDeployAddon: typeof trpc.nodes.deployAddon.useMutation = trpc.nodes.deployAddon.useMutation

/** Generated alias around `trpc.nodes.undeployAddon.useMutation`. */
export const useNodesUndeployAddon: typeof trpc.nodes.undeployAddon.useMutation = trpc.nodes.undeployAddon.useMutation

/** Generated alias around `trpc.nodes.restartAddon.useMutation`. */
export const useNodesRestartAddon: typeof trpc.nodes.restartAddon.useMutation = trpc.nodes.restartAddon.useMutation

/** Generated alias around `trpc.nodes.restartProcess.useMutation`. */
export const useNodesRestartProcess: typeof trpc.nodes.restartProcess.useMutation = trpc.nodes.restartProcess.useMutation

/** Generated alias around `trpc.nodes.restartNode.useMutation`. */
export const useNodesRestartNode: typeof trpc.nodes.restartNode.useMutation = trpc.nodes.restartNode.useMutation

/** Generated alias around `trpc.nodes.shutdownNode.useMutation`. */
export const useNodesShutdownNode: typeof trpc.nodes.shutdownNode.useMutation = trpc.nodes.shutdownNode.useMutation

/** Generated alias around `trpc.nodes.renameNode.useMutation`. */
export const useNodesRenameNode: typeof trpc.nodes.renameNode.useMutation = trpc.nodes.renameNode.useMutation

/** Generated alias around `trpc.nodes.clusterAddonStatus.useQuery`. */
export const useNodesClusterAddonStatus: typeof trpc.nodes.clusterAddonStatus.useQuery = trpc.nodes.clusterAddonStatus.useQuery

/** Generated alias around `trpc.nodes.getCapUsageGraph.useQuery`. */
export const useNodesGetCapUsageGraph: typeof trpc.nodes.getCapUsageGraph.useQuery = trpc.nodes.getCapUsageGraph.useQuery

/** Generated alias around `trpc.nodes.getNodeAddons.useQuery`. */
export const useNodesGetNodeAddons: typeof trpc.nodes.getNodeAddons.useQuery = trpc.nodes.getNodeAddons.useQuery

/** Generated alias around `trpc.nodes.setProcessLogLevel.useMutation`. */
export const useNodesSetProcessLogLevel: typeof trpc.nodes.setProcessLogLevel.useMutation = trpc.nodes.setProcessLogLevel.useMutation

/** Generated alias around `trpc.nodes.executeQuery.useMutation`. */
export const useNodesExecuteQuery: typeof trpc.nodes.executeQuery.useMutation = trpc.nodes.executeQuery.useMutation

/** Generated alias around `trpc.notificationOutput.listTargetKinds.useQuery`. */
export const useNotificationOutputListTargetKinds: typeof trpc.notificationOutput.listTargetKinds.useQuery = trpc.notificationOutput.listTargetKinds.useQuery

/** Generated alias around `trpc.notificationOutput.listTargets.useQuery`. */
export const useNotificationOutputListTargets: typeof trpc.notificationOutput.listTargets.useQuery = trpc.notificationOutput.listTargets.useQuery

/** Generated alias around `trpc.notificationOutput.getTarget.useQuery`. */
export const useNotificationOutputGetTarget: typeof trpc.notificationOutput.getTarget.useQuery = trpc.notificationOutput.getTarget.useQuery

/** Generated alias around `trpc.notificationOutput.discoverTargets.useQuery`. */
export const useNotificationOutputDiscoverTargets: typeof trpc.notificationOutput.discoverTargets.useQuery = trpc.notificationOutput.discoverTargets.useQuery

/** Generated alias around `trpc.notificationOutput.probeTargetConfig.useMutation`. */
export const useNotificationOutputProbeTargetConfig: typeof trpc.notificationOutput.probeTargetConfig.useMutation = trpc.notificationOutput.probeTargetConfig.useMutation

/** Generated alias around `trpc.notificationOutput.send.useMutation`. */
export const useNotificationOutputSend: typeof trpc.notificationOutput.send.useMutation = trpc.notificationOutput.send.useMutation

/** Generated alias around `trpc.notificationOutput.testTarget.useMutation`. */
export const useNotificationOutputTestTarget: typeof trpc.notificationOutput.testTarget.useMutation = trpc.notificationOutput.testTarget.useMutation

/** Generated alias around `trpc.notificationOutput.upsertTarget.useMutation`. */
export const useNotificationOutputUpsertTarget: typeof trpc.notificationOutput.upsertTarget.useMutation = trpc.notificationOutput.upsertTarget.useMutation

/** Generated alias around `trpc.notificationOutput.deleteTarget.useMutation`. */
export const useNotificationOutputDeleteTarget: typeof trpc.notificationOutput.deleteTarget.useMutation = trpc.notificationOutput.deleteTarget.useMutation

/** Generated alias around `trpc.notificationOutput.setTargetEnabled.useMutation`. */
export const useNotificationOutputSetTargetEnabled: typeof trpc.notificationOutput.setTargetEnabled.useMutation = trpc.notificationOutput.setTargetEnabled.useMutation

/** Generated alias around `trpc.notificationRules.listRules.useQuery`. */
export const useNotificationRulesListRules: typeof trpc.notificationRules.listRules.useQuery = trpc.notificationRules.listRules.useQuery

/** Generated alias around `trpc.notificationRules.getRule.useQuery`. */
export const useNotificationRulesGetRule: typeof trpc.notificationRules.getRule.useQuery = trpc.notificationRules.getRule.useQuery

/** Generated alias around `trpc.notificationRules.createRule.useMutation`. */
export const useNotificationRulesCreateRule: typeof trpc.notificationRules.createRule.useMutation = trpc.notificationRules.createRule.useMutation

/** Generated alias around `trpc.notificationRules.updateRule.useMutation`. */
export const useNotificationRulesUpdateRule: typeof trpc.notificationRules.updateRule.useMutation = trpc.notificationRules.updateRule.useMutation

/** Generated alias around `trpc.notificationRules.deleteRule.useMutation`. */
export const useNotificationRulesDeleteRule: typeof trpc.notificationRules.deleteRule.useMutation = trpc.notificationRules.deleteRule.useMutation

/** Generated alias around `trpc.notificationRules.setRuleEnabled.useMutation`. */
export const useNotificationRulesSetRuleEnabled: typeof trpc.notificationRules.setRuleEnabled.useMutation = trpc.notificationRules.setRuleEnabled.useMutation

/** Generated alias around `trpc.notificationRules.listSequences.useQuery`. */
export const useNotificationRulesListSequences: typeof trpc.notificationRules.listSequences.useQuery = trpc.notificationRules.listSequences.useQuery

/** Generated alias around `trpc.notificationRules.getSequence.useQuery`. */
export const useNotificationRulesGetSequence: typeof trpc.notificationRules.getSequence.useQuery = trpc.notificationRules.getSequence.useQuery

/** Generated alias around `trpc.notificationRules.createSequence.useMutation`. */
export const useNotificationRulesCreateSequence: typeof trpc.notificationRules.createSequence.useMutation = trpc.notificationRules.createSequence.useMutation

/** Generated alias around `trpc.notificationRules.updateSequence.useMutation`. */
export const useNotificationRulesUpdateSequence: typeof trpc.notificationRules.updateSequence.useMutation = trpc.notificationRules.updateSequence.useMutation

/** Generated alias around `trpc.notificationRules.deleteSequence.useMutation`. */
export const useNotificationRulesDeleteSequence: typeof trpc.notificationRules.deleteSequence.useMutation = trpc.notificationRules.deleteSequence.useMutation

/** Generated alias around `trpc.notificationRules.getClipRetentionAsks.useQuery`. */
export const useNotificationRulesGetClipRetentionAsks: typeof trpc.notificationRules.getClipRetentionAsks.useQuery = trpc.notificationRules.getClipRetentionAsks.useQuery

/** Generated alias around `trpc.notificationRules.listDeviceMutes.useQuery`. */
export const useNotificationRulesListDeviceMutes: typeof trpc.notificationRules.listDeviceMutes.useQuery = trpc.notificationRules.listDeviceMutes.useQuery

/** Generated alias around `trpc.notificationRules.setDeviceMuted.useMutation`. */
export const useNotificationRulesSetDeviceMuted: typeof trpc.notificationRules.setDeviceMuted.useMutation = trpc.notificationRules.setDeviceMuted.useMutation

/** Generated alias around `trpc.notificationRules.testRule.useMutation`. */
export const useNotificationRulesTestRule: typeof trpc.notificationRules.testRule.useMutation = trpc.notificationRules.testRule.useMutation

/** Generated alias around `trpc.notificationRules.previewStateSummary.useMutation`. */
export const useNotificationRulesPreviewStateSummary: typeof trpc.notificationRules.previewStateSummary.useMutation = trpc.notificationRules.previewStateSummary.useMutation

/** Generated alias around `trpc.notificationRules.getConditionCatalog.useQuery`. */
export const useNotificationRulesGetConditionCatalog: typeof trpc.notificationRules.getConditionCatalog.useQuery = trpc.notificationRules.getConditionCatalog.useQuery

/** Generated alias around `trpc.notificationRules.getTemplateCatalog.useQuery`. */
export const useNotificationRulesGetTemplateCatalog: typeof trpc.notificationRules.getTemplateCatalog.useQuery = trpc.notificationRules.getTemplateCatalog.useQuery

/** Generated alias around `trpc.notificationRules.previewTemplate.useMutation`. */
export const useNotificationRulesPreviewTemplate: typeof trpc.notificationRules.previewTemplate.useMutation = trpc.notificationRules.previewTemplate.useMutation

/** Generated alias around `trpc.notificationRules.getHistory.useQuery`. */
export const useNotificationRulesGetHistory: typeof trpc.notificationRules.getHistory.useQuery = trpc.notificationRules.getHistory.useQuery

/** Generated alias around `trpc.notificationRules.getRuleLastRuns.useQuery`. */
export const useNotificationRulesGetRuleLastRuns: typeof trpc.notificationRules.getRuleLastRuns.useQuery = trpc.notificationRules.getRuleLastRuns.useQuery

/** Generated alias around `trpc.notificationRules.resolveArtifactUrl.useQuery`. */
export const useNotificationRulesResolveArtifactUrl: typeof trpc.notificationRules.resolveArtifactUrl.useQuery = trpc.notificationRules.resolveArtifactUrl.useQuery

/** Generated alias around `trpc.notificationRules.listSnoozes.useQuery`. */
export const useNotificationRulesListSnoozes: typeof trpc.notificationRules.listSnoozes.useQuery = trpc.notificationRules.listSnoozes.useQuery

/** Generated alias around `trpc.notificationRules.createSnooze.useMutation`. */
export const useNotificationRulesCreateSnooze: typeof trpc.notificationRules.createSnooze.useMutation = trpc.notificationRules.createSnooze.useMutation

/** Generated alias around `trpc.notificationRules.cancelSnooze.useMutation`. */
export const useNotificationRulesCancelSnooze: typeof trpc.notificationRules.cancelSnooze.useMutation = trpc.notificationRules.cancelSnooze.useMutation

/** Generated alias around `trpc.notificationRules.getAlarmConfig.useQuery`. */
export const useNotificationRulesGetAlarmConfig: typeof trpc.notificationRules.getAlarmConfig.useQuery = trpc.notificationRules.getAlarmConfig.useQuery

/** Generated alias around `trpc.notificationRules.setAlarmConfig.useMutation`. */
export const useNotificationRulesSetAlarmConfig: typeof trpc.notificationRules.setAlarmConfig.useMutation = trpc.notificationRules.setAlarmConfig.useMutation

/** Generated alias around `trpc.notificationRules.createAlarmProfile.useMutation`. */
export const useNotificationRulesCreateAlarmProfile: typeof trpc.notificationRules.createAlarmProfile.useMutation = trpc.notificationRules.createAlarmProfile.useMutation

/** Generated alias around `trpc.notificationRules.renameAlarmProfile.useMutation`. */
export const useNotificationRulesRenameAlarmProfile: typeof trpc.notificationRules.renameAlarmProfile.useMutation = trpc.notificationRules.renameAlarmProfile.useMutation

/** Generated alias around `trpc.notificationRules.deleteAlarmProfile.useMutation`. */
export const useNotificationRulesDeleteAlarmProfile: typeof trpc.notificationRules.deleteAlarmProfile.useMutation = trpc.notificationRules.deleteAlarmProfile.useMutation

/** Generated alias around `trpc.notificationRules.activateAlarmProfile.useMutation`. */
export const useNotificationRulesActivateAlarmProfile: typeof trpc.notificationRules.activateAlarmProfile.useMutation = trpc.notificationRules.activateAlarmProfile.useMutation

/** Generated alias around `trpc.notificationRules.getAlarmSensors.useQuery`. */
export const useNotificationRulesGetAlarmSensors: typeof trpc.notificationRules.getAlarmSensors.useQuery = trpc.notificationRules.getAlarmSensors.useQuery

/** Generated alias around `trpc.notifier.send.useMutation`. */
export const useNotifierSend: typeof trpc.notifier.send.useMutation = trpc.notifier.send.useMutation

/** Generated alias around `trpc.notifier.cancel.useMutation`. */
export const useNotifierCancel: typeof trpc.notifier.cancel.useMutation = trpc.notifier.cancel.useMutation

/** Generated alias around `trpc.notifier.getStatus.useQuery`. */
export const useNotifierGetStatus: typeof trpc.notifier.getStatus.useQuery = trpc.notifier.getStatus.useQuery

/** Generated alias around `trpc.numericSensor.getStatus.useQuery`. */
export const useNumericSensorGetStatus: typeof trpc.numericSensor.getStatus.useQuery = trpc.numericSensor.getStatus.useQuery

/** Generated alias around `trpc.oidcConnections.connectionFormSchema.useQuery`. */
export const useOidcConnectionsConnectionFormSchema: typeof trpc.oidcConnections.connectionFormSchema.useQuery = trpc.oidcConnections.connectionFormSchema.useQuery

/** Generated alias around `trpc.oidcConnections.listConnections.useQuery`. */
export const useOidcConnectionsListConnections: typeof trpc.oidcConnections.listConnections.useQuery = trpc.oidcConnections.listConnections.useQuery

/** Generated alias around `trpc.oidcConnections.createConnection.useMutation`. */
export const useOidcConnectionsCreateConnection: typeof trpc.oidcConnections.createConnection.useMutation = trpc.oidcConnections.createConnection.useMutation

/** Generated alias around `trpc.oidcConnections.updateConnection.useMutation`. */
export const useOidcConnectionsUpdateConnection: typeof trpc.oidcConnections.updateConnection.useMutation = trpc.oidcConnections.updateConnection.useMutation

/** Generated alias around `trpc.oidcConnections.deleteConnection.useMutation`. */
export const useOidcConnectionsDeleteConnection: typeof trpc.oidcConnections.deleteConnection.useMutation = trpc.oidcConnections.deleteConnection.useMutation

/** Generated alias around `trpc.osd.setOverlay.useMutation`. */
export const useOsdSetOverlay: typeof trpc.osd.setOverlay.useMutation = trpc.osd.setOverlay.useMutation

/** Generated alias around `trpc.osd.getStatus.useQuery`. */
export const useOsdGetStatus: typeof trpc.osd.getStatus.useQuery = trpc.osd.getStatus.useQuery

/** Generated alias around `trpc.osdManager.getDeviceOsd.useQuery`. */
export const useOsdManagerGetDeviceOsd: typeof trpc.osdManager.getDeviceOsd.useQuery = trpc.osdManager.getDeviceOsd.useQuery

/** Generated alias around `trpc.osdManager.getSourceCatalog.useQuery`. */
export const useOsdManagerGetSourceCatalog: typeof trpc.osdManager.getSourceCatalog.useQuery = trpc.osdManager.getSourceCatalog.useQuery

/** Generated alias around `trpc.osdManager.getConditionSupport.useQuery`. */
export const useOsdManagerGetConditionSupport: typeof trpc.osdManager.getConditionSupport.useQuery = trpc.osdManager.getConditionSupport.useQuery

/** Generated alias around `trpc.osdManager.setSlotBinding.useMutation`. */
export const useOsdManagerSetSlotBinding: typeof trpc.osdManager.setSlotBinding.useMutation = trpc.osdManager.setSlotBinding.useMutation

/** Generated alias around `trpc.osdManager.clearSlotBinding.useMutation`. */
export const useOsdManagerClearSlotBinding: typeof trpc.osdManager.clearSlotBinding.useMutation = trpc.osdManager.clearSlotBinding.useMutation

/** Generated alias around `trpc.osdManager.setSlotCameraEnabled.useMutation`. */
export const useOsdManagerSetSlotCameraEnabled: typeof trpc.osdManager.setSlotCameraEnabled.useMutation = trpc.osdManager.setSlotCameraEnabled.useMutation

/** Generated alias around `trpc.osdManager.copyDeviceConfiguration.useMutation`. */
export const useOsdManagerCopyDeviceConfiguration: typeof trpc.osdManager.copyDeviceConfiguration.useMutation = trpc.osdManager.copyDeviceConfiguration.useMutation

/** Generated alias around `trpc.osdManager.previewSlot.useMutation`. */
export const useOsdManagerPreviewSlot: typeof trpc.osdManager.previewSlot.useMutation = trpc.osdManager.previewSlot.useMutation

/** Generated alias around `trpc.osdManager.renderDevice.useMutation`. */
export const useOsdManagerRenderDevice: typeof trpc.osdManager.renderDevice.useMutation = trpc.osdManager.renderDevice.useMutation

/** Generated alias around `trpc.osdManager.listTemplates.useQuery`. */
export const useOsdManagerListTemplates: typeof trpc.osdManager.listTemplates.useQuery = trpc.osdManager.listTemplates.useQuery

/** Generated alias around `trpc.osdManager.upsertTemplate.useMutation`. */
export const useOsdManagerUpsertTemplate: typeof trpc.osdManager.upsertTemplate.useMutation = trpc.osdManager.upsertTemplate.useMutation

/** Generated alias around `trpc.osdManager.deleteTemplate.useMutation`. */
export const useOsdManagerDeleteTemplate: typeof trpc.osdManager.deleteTemplate.useMutation = trpc.osdManager.deleteTemplate.useMutation

/** Generated alias around `trpc.petFeeder.feed.useMutation`. */
export const usePetFeederFeed: typeof trpc.petFeeder.feed.useMutation = trpc.petFeeder.feed.useMutation

/** Generated alias around `trpc.petFeeder.cancelFeed.useMutation`. */
export const usePetFeederCancelFeed: typeof trpc.petFeeder.cancelFeed.useMutation = trpc.petFeeder.cancelFeed.useMutation

/** Generated alias around `trpc.petFeeder.resetDesiccant.useMutation`. */
export const usePetFeederResetDesiccant: typeof trpc.petFeeder.resetDesiccant.useMutation = trpc.petFeeder.resetDesiccant.useMutation

/** Generated alias around `trpc.petFeeder.markFoodReplenished.useMutation`. */
export const usePetFeederMarkFoodReplenished: typeof trpc.petFeeder.markFoodReplenished.useMutation = trpc.petFeeder.markFoodReplenished.useMutation

/** Generated alias around `trpc.petFeeder.callPet.useMutation`. */
export const usePetFeederCallPet: typeof trpc.petFeeder.callPet.useMutation = trpc.petFeeder.callPet.useMutation

/** Generated alias around `trpc.petFeeder.playSound.useMutation`. */
export const usePetFeederPlaySound: typeof trpc.petFeeder.playSound.useMutation = trpc.petFeeder.playSound.useMutation

/** Generated alias around `trpc.petFeeder.setChildLock.useMutation`. */
export const usePetFeederSetChildLock: typeof trpc.petFeeder.setChildLock.useMutation = trpc.petFeeder.setChildLock.useMutation

/** Generated alias around `trpc.petFeeder.setIndicatorLight.useMutation`. */
export const usePetFeederSetIndicatorLight: typeof trpc.petFeeder.setIndicatorLight.useMutation = trpc.petFeeder.setIndicatorLight.useMutation

/** Generated alias around `trpc.petFeeder.setFeedSound.useMutation`. */
export const usePetFeederSetFeedSound: typeof trpc.petFeeder.setFeedSound.useMutation = trpc.petFeeder.setFeedSound.useMutation

/** Generated alias around `trpc.petFeeder.setVolume.useMutation`. */
export const usePetFeederSetVolume: typeof trpc.petFeeder.setVolume.useMutation = trpc.petFeeder.setVolume.useMutation

/** Generated alias around `trpc.petFeeder.getStatus.useQuery`. */
export const usePetFeederGetStatus: typeof trpc.petFeeder.getStatus.useQuery = trpc.petFeeder.getStatus.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getActiveTracks.useQuery`. */
export const usePipelineAnalyticsGetActiveTracks: typeof trpc.pipelineAnalytics.getActiveTracks.useQuery = trpc.pipelineAnalytics.getActiveTracks.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getTrack.useQuery`. */
export const usePipelineAnalyticsGetTrack: typeof trpc.pipelineAnalytics.getTrack.useQuery = trpc.pipelineAnalytics.getTrack.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listTracks.useQuery`. */
export const usePipelineAnalyticsListTracks: typeof trpc.pipelineAnalytics.listTracks.useQuery = trpc.pipelineAnalytics.listTracks.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listRecentTracks.useQuery`. */
export const usePipelineAnalyticsListRecentTracks: typeof trpc.pipelineAnalytics.listRecentTracks.useQuery = trpc.pipelineAnalytics.listRecentTracks.useQuery

/** Generated alias around `trpc.pipelineAnalytics.clearTracks.useMutation`. */
export const usePipelineAnalyticsClearTracks: typeof trpc.pipelineAnalytics.clearTracks.useMutation = trpc.pipelineAnalytics.clearTracks.useMutation

/** Generated alias around `trpc.pipelineAnalytics.getMotionEvents.useQuery`. */
export const usePipelineAnalyticsGetMotionEvents: typeof trpc.pipelineAnalytics.getMotionEvents.useQuery = trpc.pipelineAnalytics.getMotionEvents.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getObjectEvents.useQuery`. */
export const usePipelineAnalyticsGetObjectEvents: typeof trpc.pipelineAnalytics.getObjectEvents.useQuery = trpc.pipelineAnalytics.getObjectEvents.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getAudioEvents.useQuery`. */
export const usePipelineAnalyticsGetAudioEvents: typeof trpc.pipelineAnalytics.getAudioEvents.useQuery = trpc.pipelineAnalytics.getAudioEvents.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listEventKinds.useQuery`. */
export const usePipelineAnalyticsListEventKinds: typeof trpc.pipelineAnalytics.listEventKinds.useQuery = trpc.pipelineAnalytics.listEventKinds.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listEventKindsBatch.useQuery`. */
export const usePipelineAnalyticsListEventKindsBatch: typeof trpc.pipelineAnalytics.listEventKindsBatch.useQuery = trpc.pipelineAnalytics.listEventKindsBatch.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getSensorEvents.useQuery`. */
export const usePipelineAnalyticsGetSensorEvents: typeof trpc.pipelineAnalytics.getSensorEvents.useQuery = trpc.pipelineAnalytics.getSensorEvents.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getKeyEvents.useQuery`. */
export const usePipelineAnalyticsGetKeyEvents: typeof trpc.pipelineAnalytics.getKeyEvents.useQuery = trpc.pipelineAnalytics.getKeyEvents.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getKeyEventsBatch.useQuery`. */
export const usePipelineAnalyticsGetKeyEventsBatch: typeof trpc.pipelineAnalytics.getKeyEventsBatch.useQuery = trpc.pipelineAnalytics.getKeyEventsBatch.useQuery

/** Generated alias around `trpc.pipelineAnalytics.readLongTermSeries.useQuery`. */
export const usePipelineAnalyticsReadLongTermSeries: typeof trpc.pipelineAnalytics.readLongTermSeries.useQuery = trpc.pipelineAnalytics.readLongTermSeries.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getEventDensity.useQuery`. */
export const usePipelineAnalyticsGetEventDensity: typeof trpc.pipelineAnalytics.getEventDensity.useQuery = trpc.pipelineAnalytics.getEventDensity.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getEventDensityBatch.useQuery`. */
export const usePipelineAnalyticsGetEventDensityBatch: typeof trpc.pipelineAnalytics.getEventDensityBatch.useQuery = trpc.pipelineAnalytics.getEventDensityBatch.useQuery

/** Generated alias around `trpc.pipelineAnalytics.pruneEventsBefore.useMutation`. */
export const usePipelineAnalyticsPruneEventsBefore: typeof trpc.pipelineAnalytics.pruneEventsBefore.useMutation = trpc.pipelineAnalytics.pruneEventsBefore.useMutation

/** Generated alias around `trpc.pipelineAnalytics.pruneTracksBefore.useMutation`. */
export const usePipelineAnalyticsPruneTracksBefore: typeof trpc.pipelineAnalytics.pruneTracksBefore.useMutation = trpc.pipelineAnalytics.pruneTracksBefore.useMutation

/** Generated alias around `trpc.pipelineAnalytics.wipeAllAnalytics.useMutation`. */
export const usePipelineAnalyticsWipeAllAnalytics: typeof trpc.pipelineAnalytics.wipeAllAnalytics.useMutation = trpc.pipelineAnalytics.wipeAllAnalytics.useMutation

/** Generated alias around `trpc.pipelineAnalytics.reconcileFromDisk.useMutation`. */
export const usePipelineAnalyticsReconcileFromDisk: typeof trpc.pipelineAnalytics.reconcileFromDisk.useMutation = trpc.pipelineAnalytics.reconcileFromDisk.useMutation

/** Generated alias around `trpc.pipelineAnalytics.deleteTracks.useMutation`. */
export const usePipelineAnalyticsDeleteTracks: typeof trpc.pipelineAnalytics.deleteTracks.useMutation = trpc.pipelineAnalytics.deleteTracks.useMutation

/** Generated alias around `trpc.pipelineAnalytics.setTrackFlags.useMutation`. */
export const usePipelineAnalyticsSetTrackFlags: typeof trpc.pipelineAnalytics.setTrackFlags.useMutation = trpc.pipelineAnalytics.setTrackFlags.useMutation

/** Generated alias around `trpc.pipelineAnalytics.listArchivedDebugNotes.useQuery`. */
export const usePipelineAnalyticsListArchivedDebugNotes: typeof trpc.pipelineAnalytics.listArchivedDebugNotes.useQuery = trpc.pipelineAnalytics.listArchivedDebugNotes.useQuery

/** Generated alias around `trpc.pipelineAnalytics.setTrackRelation.useMutation`. */
export const usePipelineAnalyticsSetTrackRelation: typeof trpc.pipelineAnalytics.setTrackRelation.useMutation = trpc.pipelineAnalytics.setTrackRelation.useMutation

/** Generated alias around `trpc.pipelineAnalytics.clearTrackRelation.useMutation`. */
export const usePipelineAnalyticsClearTrackRelation: typeof trpc.pipelineAnalytics.clearTrackRelation.useMutation = trpc.pipelineAnalytics.clearTrackRelation.useMutation

/** Generated alias around `trpc.pipelineAnalytics.setTrackPurity.useMutation`. */
export const usePipelineAnalyticsSetTrackPurity: typeof trpc.pipelineAnalytics.setTrackPurity.useMutation = trpc.pipelineAnalytics.setTrackPurity.useMutation

/** Generated alias around `trpc.pipelineAnalytics.listTrackRelations.useQuery`. */
export const usePipelineAnalyticsListTrackRelations: typeof trpc.pipelineAnalytics.listTrackRelations.useQuery = trpc.pipelineAnalytics.listTrackRelations.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listBirthDecisions.useQuery`. */
export const usePipelineAnalyticsListBirthDecisions: typeof trpc.pipelineAnalytics.listBirthDecisions.useQuery = trpc.pipelineAnalytics.listBirthDecisions.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getEventStoreFootprint.useQuery`. */
export const usePipelineAnalyticsGetEventStoreFootprint: typeof trpc.pipelineAnalytics.getEventStoreFootprint.useQuery = trpc.pipelineAnalytics.getEventStoreFootprint.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getEventMediaFootprintByKind.useQuery`. */
export const usePipelineAnalyticsGetEventMediaFootprintByKind: typeof trpc.pipelineAnalytics.getEventMediaFootprintByKind.useQuery = trpc.pipelineAnalytics.getEventMediaFootprintByKind.useQuery

/** Generated alias around `trpc.pipelineAnalytics.pruneEvents.useMutation`. */
export const usePipelineAnalyticsPruneEvents: typeof trpc.pipelineAnalytics.pruneEvents.useMutation = trpc.pipelineAnalytics.pruneEvents.useMutation

/** Generated alias around `trpc.pipelineAnalytics.deleteDeviceEvents.useMutation`. */
export const usePipelineAnalyticsDeleteDeviceEvents: typeof trpc.pipelineAnalytics.deleteDeviceEvents.useMutation = trpc.pipelineAnalytics.deleteDeviceEvents.useMutation

/** Generated alias around `trpc.pipelineAnalytics.pauseForStorageMigration.useMutation`. */
export const usePipelineAnalyticsPauseForStorageMigration: typeof trpc.pipelineAnalytics.pauseForStorageMigration.useMutation = trpc.pipelineAnalytics.pauseForStorageMigration.useMutation

/** Generated alias around `trpc.pipelineAnalytics.resumeForStorageMigration.useMutation`. */
export const usePipelineAnalyticsResumeForStorageMigration: typeof trpc.pipelineAnalytics.resumeForStorageMigration.useMutation = trpc.pipelineAnalytics.resumeForStorageMigration.useMutation

/** Generated alias around `trpc.pipelineAnalytics.refreshStorageLocationsForMigration.useMutation`. */
export const usePipelineAnalyticsRefreshStorageLocationsForMigration: typeof trpc.pipelineAnalytics.refreshStorageLocationsForMigration.useMutation = trpc.pipelineAnalytics.refreshStorageLocationsForMigration.useMutation

/** Generated alias around `trpc.pipelineAnalytics.startStorageMigrationMove.useMutation`. */
export const usePipelineAnalyticsStartStorageMigrationMove: typeof trpc.pipelineAnalytics.startStorageMigrationMove.useMutation = trpc.pipelineAnalytics.startStorageMigrationMove.useMutation

/** Generated alias around `trpc.pipelineAnalytics.getStorageMigrationMoveStatus.useQuery`. */
export const usePipelineAnalyticsGetStorageMigrationMoveStatus: typeof trpc.pipelineAnalytics.getStorageMigrationMoveStatus.useQuery = trpc.pipelineAnalytics.getStorageMigrationMoveStatus.useQuery

/** Generated alias around `trpc.pipelineAnalytics.cancelStorageMigrationMove.useMutation`. */
export const usePipelineAnalyticsCancelStorageMigrationMove: typeof trpc.pipelineAnalytics.cancelStorageMigrationMove.useMutation = trpc.pipelineAnalytics.cancelStorageMigrationMove.useMutation

/** Generated alias around `trpc.pipelineAnalytics.relocateMedia.useMutation`. */
export const usePipelineAnalyticsRelocateMedia: typeof trpc.pipelineAnalytics.relocateMedia.useMutation = trpc.pipelineAnalytics.relocateMedia.useMutation

/** Generated alias around `trpc.pipelineAnalytics.countUnstampedEventMedia.useQuery`. */
export const usePipelineAnalyticsCountUnstampedEventMedia: typeof trpc.pipelineAnalytics.countUnstampedEventMedia.useQuery = trpc.pipelineAnalytics.countUnstampedEventMedia.useQuery

/** Generated alias around `trpc.pipelineAnalytics.countRelocatableMedia.useQuery`. */
export const usePipelineAnalyticsCountRelocatableMedia: typeof trpc.pipelineAnalytics.countRelocatableMedia.useQuery = trpc.pipelineAnalytics.countRelocatableMedia.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listRelocateMediaJobs.useQuery`. */
export const usePipelineAnalyticsListRelocateMediaJobs: typeof trpc.pipelineAnalytics.listRelocateMediaJobs.useQuery = trpc.pipelineAnalytics.listRelocateMediaJobs.useQuery

/** Generated alias around `trpc.pipelineAnalytics.cancelRelocateMedia.useMutation`. */
export const usePipelineAnalyticsCancelRelocateMedia: typeof trpc.pipelineAnalytics.cancelRelocateMedia.useMutation = trpc.pipelineAnalytics.cancelRelocateMedia.useMutation

/** Generated alias around `trpc.pipelineAnalytics.listOpsLog.useQuery`. */
export const usePipelineAnalyticsListOpsLog: typeof trpc.pipelineAnalytics.listOpsLog.useQuery = trpc.pipelineAnalytics.listOpsLog.useQuery

/** Generated alias around `trpc.pipelineAnalytics.reclaimDebugMedia.useMutation`. */
export const usePipelineAnalyticsReclaimDebugMedia: typeof trpc.pipelineAnalytics.reclaimDebugMedia.useMutation = trpc.pipelineAnalytics.reclaimDebugMedia.useMutation

/** Generated alias around `trpc.pipelineAnalytics.getMediaReclaimStatus.useQuery`. */
export const usePipelineAnalyticsGetMediaReclaimStatus: typeof trpc.pipelineAnalytics.getMediaReclaimStatus.useQuery = trpc.pipelineAnalytics.getMediaReclaimStatus.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getTrainingExportSummary.useQuery`. */
export const usePipelineAnalyticsGetTrainingExportSummary: typeof trpc.pipelineAnalytics.getTrainingExportSummary.useQuery = trpc.pipelineAnalytics.getTrainingExportSummary.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getTrainingExportUrl.useQuery`. */
export const usePipelineAnalyticsGetTrainingExportUrl: typeof trpc.pipelineAnalytics.getTrainingExportUrl.useQuery = trpc.pipelineAnalytics.getTrainingExportUrl.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listRetrainStaging.useQuery`. */
export const usePipelineAnalyticsListRetrainStaging: typeof trpc.pipelineAnalytics.listRetrainStaging.useQuery = trpc.pipelineAnalytics.listRetrainStaging.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listRetrainCorpusPage.useQuery`. */
export const usePipelineAnalyticsListRetrainCorpusPage: typeof trpc.pipelineAnalytics.listRetrainCorpusPage.useQuery = trpc.pipelineAnalytics.listRetrainCorpusPage.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getRetrainCorpusKpi.useQuery`. */
export const usePipelineAnalyticsGetRetrainCorpusKpi: typeof trpc.pipelineAnalytics.getRetrainCorpusKpi.useQuery = trpc.pipelineAnalytics.getRetrainCorpusKpi.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listRetrainFrames.useQuery`. */
export const usePipelineAnalyticsListRetrainFrames: typeof trpc.pipelineAnalytics.listRetrainFrames.useQuery = trpc.pipelineAnalytics.listRetrainFrames.useQuery

/** Generated alias around `trpc.pipelineAnalytics.selectRetrainFrames.useMutation`. */
export const usePipelineAnalyticsSelectRetrainFrames: typeof trpc.pipelineAnalytics.selectRetrainFrames.useMutation = trpc.pipelineAnalytics.selectRetrainFrames.useMutation

/** Generated alias around `trpc.pipelineAnalytics.deselectRetrainFrame.useMutation`. */
export const usePipelineAnalyticsDeselectRetrainFrame: typeof trpc.pipelineAnalytics.deselectRetrainFrame.useMutation = trpc.pipelineAnalytics.deselectRetrainFrame.useMutation

/** Generated alias around `trpc.pipelineAnalytics.getRetrainFrameImage.useQuery`. */
export const usePipelineAnalyticsGetRetrainFrameImage: typeof trpc.pipelineAnalytics.getRetrainFrameImage.useQuery = trpc.pipelineAnalytics.getRetrainFrameImage.useQuery

/** Generated alias around `trpc.pipelineAnalytics.proposeRetrainAnnotations.useMutation`. */
export const usePipelineAnalyticsProposeRetrainAnnotations: typeof trpc.pipelineAnalytics.proposeRetrainAnnotations.useMutation = trpc.pipelineAnalytics.proposeRetrainAnnotations.useMutation

/** Generated alias around `trpc.pipelineAnalytics.listRetrainAnnotations.useQuery`. */
export const usePipelineAnalyticsListRetrainAnnotations: typeof trpc.pipelineAnalytics.listRetrainAnnotations.useQuery = trpc.pipelineAnalytics.listRetrainAnnotations.useQuery

/** Generated alias around `trpc.pipelineAnalytics.saveRetrainAnnotations.useMutation`. */
export const usePipelineAnalyticsSaveRetrainAnnotations: typeof trpc.pipelineAnalytics.saveRetrainAnnotations.useMutation = trpc.pipelineAnalytics.saveRetrainAnnotations.useMutation

/** Generated alias around `trpc.pipelineAnalytics.backfillRetrainOrigins.useMutation`. */
export const usePipelineAnalyticsBackfillRetrainOrigins: typeof trpc.pipelineAnalytics.backfillRetrainOrigins.useMutation = trpc.pipelineAnalytics.backfillRetrainOrigins.useMutation

/** Generated alias around `trpc.pipelineAnalytics.completeRetrainTrack.useMutation`. */
export const usePipelineAnalyticsCompleteRetrainTrack: typeof trpc.pipelineAnalytics.completeRetrainTrack.useMutation = trpc.pipelineAnalytics.completeRetrainTrack.useMutation

/** Generated alias around `trpc.pipelineAnalytics.restageRetrainTrack.useMutation`. */
export const usePipelineAnalyticsRestageRetrainTrack: typeof trpc.pipelineAnalytics.restageRetrainTrack.useMutation = trpc.pipelineAnalytics.restageRetrainTrack.useMutation

/** Generated alias around `trpc.pipelineAnalytics.getRetrainExportUrl.useQuery`. */
export const usePipelineAnalyticsGetRetrainExportUrl: typeof trpc.pipelineAnalytics.getRetrainExportUrl.useQuery = trpc.pipelineAnalytics.getRetrainExportUrl.useQuery

/** Generated alias around `trpc.pipelineAnalytics.setRetrainFrameComplete.useMutation`. */
export const usePipelineAnalyticsSetRetrainFrameComplete: typeof trpc.pipelineAnalytics.setRetrainFrameComplete.useMutation = trpc.pipelineAnalytics.setRetrainFrameComplete.useMutation

/** Generated alias around `trpc.pipelineAnalytics.writeRetrainArchive.useMutation`. */
export const usePipelineAnalyticsWriteRetrainArchive: typeof trpc.pipelineAnalytics.writeRetrainArchive.useMutation = trpc.pipelineAnalytics.writeRetrainArchive.useMutation

/** Generated alias around `trpc.pipelineAnalytics.offerRetrainArchive.useMutation`. */
export const usePipelineAnalyticsOfferRetrainArchive: typeof trpc.pipelineAnalytics.offerRetrainArchive.useMutation = trpc.pipelineAnalytics.offerRetrainArchive.useMutation

/** Generated alias around `trpc.pipelineAnalytics.listRetrainAssistProfiles.useQuery`. */
export const usePipelineAnalyticsListRetrainAssistProfiles: typeof trpc.pipelineAnalytics.listRetrainAssistProfiles.useQuery = trpc.pipelineAnalytics.listRetrainAssistProfiles.useQuery

/** Generated alias around `trpc.pipelineAnalytics.proposeRetrainAnnotationsWithLlm.useMutation`. */
export const usePipelineAnalyticsProposeRetrainAnnotationsWithLlm: typeof trpc.pipelineAnalytics.proposeRetrainAnnotationsWithLlm.useMutation = trpc.pipelineAnalytics.proposeRetrainAnnotationsWithLlm.useMutation

/** Generated alias around `trpc.pipelineAnalytics.createRetrainCollection.useMutation`. */
export const usePipelineAnalyticsCreateRetrainCollection: typeof trpc.pipelineAnalytics.createRetrainCollection.useMutation = trpc.pipelineAnalytics.createRetrainCollection.useMutation

/** Generated alias around `trpc.pipelineAnalytics.listRetrainCollections.useQuery`. */
export const usePipelineAnalyticsListRetrainCollections: typeof trpc.pipelineAnalytics.listRetrainCollections.useQuery = trpc.pipelineAnalytics.listRetrainCollections.useQuery

/** Generated alias around `trpc.pipelineAnalytics.resolveRetrainTrainingCorpus.useQuery`. */
export const usePipelineAnalyticsResolveRetrainTrainingCorpus: typeof trpc.pipelineAnalytics.resolveRetrainTrainingCorpus.useQuery = trpc.pipelineAnalytics.resolveRetrainTrainingCorpus.useQuery

/** Generated alias around `trpc.pipelineAnalytics.renameRetrainCollection.useMutation`. */
export const usePipelineAnalyticsRenameRetrainCollection: typeof trpc.pipelineAnalytics.renameRetrainCollection.useMutation = trpc.pipelineAnalytics.renameRetrainCollection.useMutation

/** Generated alias around `trpc.pipelineAnalytics.deleteRetrainCollection.useMutation`. */
export const usePipelineAnalyticsDeleteRetrainCollection: typeof trpc.pipelineAnalytics.deleteRetrainCollection.useMutation = trpc.pipelineAnalytics.deleteRetrainCollection.useMutation

/** Generated alias around `trpc.pipelineAnalytics.addRetrainFrameFromRecording.useMutation`. */
export const usePipelineAnalyticsAddRetrainFrameFromRecording: typeof trpc.pipelineAnalytics.addRetrainFrameFromRecording.useMutation = trpc.pipelineAnalytics.addRetrainFrameFromRecording.useMutation

/** Generated alias around `trpc.pipelineAnalytics.addRetrainFramesToCollection.useMutation`. */
export const usePipelineAnalyticsAddRetrainFramesToCollection: typeof trpc.pipelineAnalytics.addRetrainFramesToCollection.useMutation = trpc.pipelineAnalytics.addRetrainFramesToCollection.useMutation

/** Generated alias around `trpc.pipelineAnalytics.removeRetrainFrameFromCollection.useMutation`. */
export const usePipelineAnalyticsRemoveRetrainFrameFromCollection: typeof trpc.pipelineAnalytics.removeRetrainFrameFromCollection.useMutation = trpc.pipelineAnalytics.removeRetrainFrameFromCollection.useMutation

/** Generated alias around `trpc.pipelineAnalytics.listRetrainCollectionFrames.useQuery`. */
export const usePipelineAnalyticsListRetrainCollectionFrames: typeof trpc.pipelineAnalytics.listRetrainCollectionFrames.useQuery = trpc.pipelineAnalytics.listRetrainCollectionFrames.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getEventMedia.useQuery`. */
export const usePipelineAnalyticsGetEventMedia: typeof trpc.pipelineAnalytics.getEventMedia.useQuery = trpc.pipelineAnalytics.getEventMedia.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getTrackMedia.useQuery`. */
export const usePipelineAnalyticsGetTrackMedia: typeof trpc.pipelineAnalytics.getTrackMedia.useQuery = trpc.pipelineAnalytics.getTrackMedia.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listTrackMedia.useQuery`. */
export const usePipelineAnalyticsListTrackMedia: typeof trpc.pipelineAnalytics.listTrackMedia.useQuery = trpc.pipelineAnalytics.listTrackMedia.useQuery

/** Generated alias around `trpc.pipelineAnalytics.listEventMedia.useQuery`. */
export const usePipelineAnalyticsListEventMedia: typeof trpc.pipelineAnalytics.listEventMedia.useQuery = trpc.pipelineAnalytics.listEventMedia.useQuery

/** Generated alias around `trpc.pipelineAnalytics.ownersWithMedia.useQuery`. */
export const usePipelineAnalyticsOwnersWithMedia: typeof trpc.pipelineAnalytics.ownersWithMedia.useQuery = trpc.pipelineAnalytics.ownersWithMedia.useQuery

/** Generated alias around `trpc.pipelineAnalytics.searchObjectEvents.useQuery`. */
export const usePipelineAnalyticsSearchObjectEvents: typeof trpc.pipelineAnalytics.searchObjectEvents.useQuery = trpc.pipelineAnalytics.searchObjectEvents.useQuery

/** Generated alias around `trpc.pipelineAnalytics.wipeObjectEmbeddings.useMutation`. */
export const usePipelineAnalyticsWipeObjectEmbeddings: typeof trpc.pipelineAnalytics.wipeObjectEmbeddings.useMutation = trpc.pipelineAnalytics.wipeObjectEmbeddings.useMutation

/** Generated alias around `trpc.pipelineAnalytics.rebuildObjectEmbeddings.useMutation`. */
export const usePipelineAnalyticsRebuildObjectEmbeddings: typeof trpc.pipelineAnalytics.rebuildObjectEmbeddings.useMutation = trpc.pipelineAnalytics.rebuildObjectEmbeddings.useMutation

/** Generated alias around `trpc.pipelineAnalytics.getObjectEmbeddingRebuildStatus.useQuery`. */
export const usePipelineAnalyticsGetObjectEmbeddingRebuildStatus: typeof trpc.pipelineAnalytics.getObjectEmbeddingRebuildStatus.useQuery = trpc.pipelineAnalytics.getObjectEmbeddingRebuildStatus.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getDeviceSettingsContribution.useQuery`. */
export const usePipelineAnalyticsGetDeviceSettingsContribution: typeof trpc.pipelineAnalytics.getDeviceSettingsContribution.useQuery = trpc.pipelineAnalytics.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.pipelineAnalytics.getDeviceLiveContribution.useQuery`. */
export const usePipelineAnalyticsGetDeviceLiveContribution: typeof trpc.pipelineAnalytics.getDeviceLiveContribution.useQuery = trpc.pipelineAnalytics.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.pipelineAnalytics.applyDeviceSettingsPatch.useMutation`. */
export const usePipelineAnalyticsApplyDeviceSettingsPatch: typeof trpc.pipelineAnalytics.applyDeviceSettingsPatch.useMutation = trpc.pipelineAnalytics.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.pipelineExecutor.getAvailableEngines.useQuery`. */
export const usePipelineExecutorGetAvailableEngines: typeof trpc.pipelineExecutor.getAvailableEngines.useQuery = trpc.pipelineExecutor.getAvailableEngines.useQuery

/** Generated alias around `trpc.pipelineExecutor.getSelectedEngine.useQuery`. */
export const usePipelineExecutorGetSelectedEngine: typeof trpc.pipelineExecutor.getSelectedEngine.useQuery = trpc.pipelineExecutor.getSelectedEngine.useQuery

/** Generated alias around `trpc.pipelineExecutor.getEngineProvisioning.useQuery`. */
export const usePipelineExecutorGetEngineProvisioning: typeof trpc.pipelineExecutor.getEngineProvisioning.useQuery = trpc.pipelineExecutor.getEngineProvisioning.useQuery

/** Generated alias around `trpc.pipelineExecutor.getVideoPipelineSteps.useQuery`. */
export const usePipelineExecutorGetVideoPipelineSteps: typeof trpc.pipelineExecutor.getVideoPipelineSteps.useQuery = trpc.pipelineExecutor.getVideoPipelineSteps.useQuery

/** Generated alias around `trpc.pipelineExecutor.setVideoPipelineSteps.useMutation`. */
export const usePipelineExecutorSetVideoPipelineSteps: typeof trpc.pipelineExecutor.setVideoPipelineSteps.useMutation = trpc.pipelineExecutor.setVideoPipelineSteps.useMutation

/** Generated alias around `trpc.pipelineExecutor.getInferenceDeviceHealth.useQuery`. */
export const usePipelineExecutorGetInferenceDeviceHealth: typeof trpc.pipelineExecutor.getInferenceDeviceHealth.useQuery = trpc.pipelineExecutor.getInferenceDeviceHealth.useQuery

/** Generated alias around `trpc.pipelineExecutor.rearmInferenceDevice.useMutation`. */
export const usePipelineExecutorRearmInferenceDevice: typeof trpc.pipelineExecutor.rearmInferenceDevice.useMutation = trpc.pipelineExecutor.rearmInferenceDevice.useMutation

/** Generated alias around `trpc.pipelineExecutor.getSchema.useQuery`. */
export const usePipelineExecutorGetSchema: typeof trpc.pipelineExecutor.getSchema.useQuery = trpc.pipelineExecutor.getSchema.useQuery

/** Generated alias around `trpc.pipelineExecutor.getOrchestratorConfigSchema.useQuery`. */
export const usePipelineExecutorGetOrchestratorConfigSchema: typeof trpc.pipelineExecutor.getOrchestratorConfigSchema.useQuery = trpc.pipelineExecutor.getOrchestratorConfigSchema.useQuery

/** Generated alias around `trpc.pipelineExecutor.validatePipeline.useQuery`. */
export const usePipelineExecutorValidatePipeline: typeof trpc.pipelineExecutor.validatePipeline.useQuery = trpc.pipelineExecutor.validatePipeline.useQuery

/** Generated alias around `trpc.pipelineExecutor.getCapabilities.useQuery`. */
export const usePipelineExecutorGetCapabilities: typeof trpc.pipelineExecutor.getCapabilities.useQuery = trpc.pipelineExecutor.getCapabilities.useQuery

/** Generated alias around `trpc.pipelineExecutor.getAddonModels.useQuery`. */
export const usePipelineExecutorGetAddonModels: typeof trpc.pipelineExecutor.getAddonModels.useQuery = trpc.pipelineExecutor.getAddonModels.useQuery

/** Generated alias around `trpc.pipelineExecutor.downloadModel.useMutation`. */
export const usePipelineExecutorDownloadModel: typeof trpc.pipelineExecutor.downloadModel.useMutation = trpc.pipelineExecutor.downloadModel.useMutation

/** Generated alias around `trpc.pipelineExecutor.deleteModel.useMutation`. */
export const usePipelineExecutorDeleteModel: typeof trpc.pipelineExecutor.deleteModel.useMutation = trpc.pipelineExecutor.deleteModel.useMutation

/** Generated alias around `trpc.pipelineExecutor.runPipeline.useMutation`. */
export const usePipelineExecutorRunPipeline: typeof trpc.pipelineExecutor.runPipeline.useMutation = trpc.pipelineExecutor.runPipeline.useMutation

/** Generated alias around `trpc.pipelineExecutor.runPipelineBatch.useMutation`. */
export const usePipelineExecutorRunPipelineBatch: typeof trpc.pipelineExecutor.runPipelineBatch.useMutation = trpc.pipelineExecutor.runPipelineBatch.useMutation

/** Generated alias around `trpc.pipelineExecutor.cacheFrameInPool.useMutation`. */
export const usePipelineExecutorCacheFrameInPool: typeof trpc.pipelineExecutor.cacheFrameInPool.useMutation = trpc.pipelineExecutor.cacheFrameInPool.useMutation

/** Generated alias around `trpc.pipelineExecutor.inferCached.useMutation`. */
export const usePipelineExecutorInferCached: typeof trpc.pipelineExecutor.inferCached.useMutation = trpc.pipelineExecutor.inferCached.useMutation

/** Generated alias around `trpc.pipelineExecutor.uncacheFrame.useMutation`. */
export const usePipelineExecutorUncacheFrame: typeof trpc.pipelineExecutor.uncacheFrame.useMutation = trpc.pipelineExecutor.uncacheFrame.useMutation

/** Generated alias around `trpc.pipelineExecutor.getEffectiveTuning.useQuery`. */
export const usePipelineExecutorGetEffectiveTuning: typeof trpc.pipelineExecutor.getEffectiveTuning.useQuery = trpc.pipelineExecutor.getEffectiveTuning.useQuery

/** Generated alias around `trpc.pipelineExecutor.listLoadedEngines.useQuery`. */
export const usePipelineExecutorListLoadedEngines: typeof trpc.pipelineExecutor.listLoadedEngines.useQuery = trpc.pipelineExecutor.listLoadedEngines.useQuery

/** Generated alias around `trpc.pipelineExecutor.spinEngine.useMutation`. */
export const usePipelineExecutorSpinEngine: typeof trpc.pipelineExecutor.spinEngine.useMutation = trpc.pipelineExecutor.spinEngine.useMutation

/** Generated alias around `trpc.pipelineExecutor.killEngine.useMutation`. */
export const usePipelineExecutorKillEngine: typeof trpc.pipelineExecutor.killEngine.useMutation = trpc.pipelineExecutor.killEngine.useMutation

/** Generated alias around `trpc.pipelineExecutor.listReferenceImages.useQuery`. */
export const usePipelineExecutorListReferenceImages: typeof trpc.pipelineExecutor.listReferenceImages.useQuery = trpc.pipelineExecutor.listReferenceImages.useQuery

/** Generated alias around `trpc.pipelineExecutor.getReferenceImage.useQuery`. */
export const usePipelineExecutorGetReferenceImage: typeof trpc.pipelineExecutor.getReferenceImage.useQuery = trpc.pipelineExecutor.getReferenceImage.useQuery

/** Generated alias around `trpc.pipelineExecutor.getReferenceAudioFiles.useQuery`. */
export const usePipelineExecutorGetReferenceAudioFiles: typeof trpc.pipelineExecutor.getReferenceAudioFiles.useQuery = trpc.pipelineExecutor.getReferenceAudioFiles.useQuery

/** Generated alias around `trpc.pipelineExecutor.getReferenceAudio.useQuery`. */
export const usePipelineExecutorGetReferenceAudio: typeof trpc.pipelineExecutor.getReferenceAudio.useQuery = trpc.pipelineExecutor.getReferenceAudio.useQuery

/** Generated alias around `trpc.pipelineExecutor.getAudioCapabilities.useQuery`. */
export const usePipelineExecutorGetAudioCapabilities: typeof trpc.pipelineExecutor.getAudioCapabilities.useQuery = trpc.pipelineExecutor.getAudioCapabilities.useQuery

/** Generated alias around `trpc.pipelineExecutor.runAudioTest.useMutation`. */
export const usePipelineExecutorRunAudioTest: typeof trpc.pipelineExecutor.runAudioTest.useMutation = trpc.pipelineExecutor.runAudioTest.useMutation

/** Generated alias around `trpc.pipelineExecutor.getDetectionConfigSchema.useQuery`. */
export const usePipelineExecutorGetDetectionConfigSchema: typeof trpc.pipelineExecutor.getDetectionConfigSchema.useQuery = trpc.pipelineExecutor.getDetectionConfigSchema.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.requestOccupancyLook.useMutation`. */
export const usePipelineOrchestratorRequestOccupancyLook: typeof trpc.pipelineOrchestrator.requestOccupancyLook.useMutation = trpc.pipelineOrchestrator.requestOccupancyLook.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.pauseForStorageMigration.useMutation`. */
export const usePipelineOrchestratorPauseForStorageMigration: typeof trpc.pipelineOrchestrator.pauseForStorageMigration.useMutation = trpc.pipelineOrchestrator.pauseForStorageMigration.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.resumeForStorageMigration.useMutation`. */
export const usePipelineOrchestratorResumeForStorageMigration: typeof trpc.pipelineOrchestrator.resumeForStorageMigration.useMutation = trpc.pipelineOrchestrator.resumeForStorageMigration.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.assignPipeline.useMutation`. */
export const usePipelineOrchestratorAssignPipeline: typeof trpc.pipelineOrchestrator.assignPipeline.useMutation = trpc.pipelineOrchestrator.assignPipeline.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.unassignPipeline.useMutation`. */
export const usePipelineOrchestratorUnassignPipeline: typeof trpc.pipelineOrchestrator.unassignPipeline.useMutation = trpc.pipelineOrchestrator.unassignPipeline.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setPipelineDevicePin.useMutation`. */
export const usePipelineOrchestratorSetPipelineDevicePin: typeof trpc.pipelineOrchestrator.setPipelineDevicePin.useMutation = trpc.pipelineOrchestrator.setPipelineDevicePin.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getPipelineDevicePin.useQuery`. */
export const usePipelineOrchestratorGetPipelineDevicePin: typeof trpc.pipelineOrchestrator.getPipelineDevicePin.useQuery = trpc.pipelineOrchestrator.getPipelineDevicePin.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.rebalance.useMutation`. */
export const usePipelineOrchestratorRebalance: typeof trpc.pipelineOrchestrator.rebalance.useMutation = trpc.pipelineOrchestrator.rebalance.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getPipelineAssignments.useQuery`. */
export const usePipelineOrchestratorGetPipelineAssignments: typeof trpc.pipelineOrchestrator.getPipelineAssignments.useQuery = trpc.pipelineOrchestrator.getPipelineAssignments.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getPipelineAssignment.useQuery`. */
export const usePipelineOrchestratorGetPipelineAssignment: typeof trpc.pipelineOrchestrator.getPipelineAssignment.useQuery = trpc.pipelineOrchestrator.getPipelineAssignment.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getAgentLoad.useQuery`. */
export const usePipelineOrchestratorGetAgentLoad: typeof trpc.pipelineOrchestrator.getAgentLoad.useQuery = trpc.pipelineOrchestrator.getAgentLoad.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getClusterModelChoice.useQuery`. */
export const usePipelineOrchestratorGetClusterModelChoice: typeof trpc.pipelineOrchestrator.getClusterModelChoice.useQuery = trpc.pipelineOrchestrator.getClusterModelChoice.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getGlobalMetrics.useQuery`. */
export const usePipelineOrchestratorGetGlobalMetrics: typeof trpc.pipelineOrchestrator.getGlobalMetrics.useQuery = trpc.pipelineOrchestrator.getGlobalMetrics.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getCameraMetrics.useQuery`. */
export const usePipelineOrchestratorGetCameraMetrics: typeof trpc.pipelineOrchestrator.getCameraMetrics.useQuery = trpc.pipelineOrchestrator.getCameraMetrics.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getCapabilityBindings.useQuery`. */
export const usePipelineOrchestratorGetCapabilityBindings: typeof trpc.pipelineOrchestrator.getCapabilityBindings.useQuery = trpc.pipelineOrchestrator.getCapabilityBindings.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.setCapabilityBinding.useMutation`. */
export const usePipelineOrchestratorSetCapabilityBinding: typeof trpc.pipelineOrchestrator.setCapabilityBinding.useMutation = trpc.pipelineOrchestrator.setCapabilityBinding.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getIngestOwner.useQuery`. */
export const usePipelineOrchestratorGetIngestOwner: typeof trpc.pipelineOrchestrator.getIngestOwner.useQuery = trpc.pipelineOrchestrator.getIngestOwner.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.assignAudio.useMutation`. */
export const usePipelineOrchestratorAssignAudio: typeof trpc.pipelineOrchestrator.assignAudio.useMutation = trpc.pipelineOrchestrator.assignAudio.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.unassignAudio.useMutation`. */
export const usePipelineOrchestratorUnassignAudio: typeof trpc.pipelineOrchestrator.unassignAudio.useMutation = trpc.pipelineOrchestrator.unassignAudio.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getAudioAssignment.useQuery`. */
export const usePipelineOrchestratorGetAudioAssignment: typeof trpc.pipelineOrchestrator.getAudioAssignment.useQuery = trpc.pipelineOrchestrator.getAudioAssignment.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getAudioNodeLoad.useQuery`. */
export const usePipelineOrchestratorGetAudioNodeLoad: typeof trpc.pipelineOrchestrator.getAudioNodeLoad.useQuery = trpc.pipelineOrchestrator.getAudioNodeLoad.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getAudioAssignments.useQuery`. */
export const usePipelineOrchestratorGetAudioAssignments: typeof trpc.pipelineOrchestrator.getAudioAssignments.useQuery = trpc.pipelineOrchestrator.getAudioAssignments.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getAgentSettings.useQuery`. */
export const usePipelineOrchestratorGetAgentSettings: typeof trpc.pipelineOrchestrator.getAgentSettings.useQuery = trpc.pipelineOrchestrator.getAgentSettings.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.listAgentSettings.useQuery`. */
export const usePipelineOrchestratorListAgentSettings: typeof trpc.pipelineOrchestrator.listAgentSettings.useQuery = trpc.pipelineOrchestrator.listAgentSettings.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.removeAgentSettings.useMutation`. */
export const usePipelineOrchestratorRemoveAgentSettings: typeof trpc.pipelineOrchestrator.removeAgentSettings.useMutation = trpc.pipelineOrchestrator.removeAgentSettings.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setAgentMaxCameras.useMutation`. */
export const usePipelineOrchestratorSetAgentMaxCameras: typeof trpc.pipelineOrchestrator.setAgentMaxCameras.useMutation = trpc.pipelineOrchestrator.setAgentMaxCameras.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setAgentCapabilities.useMutation`. */
export const usePipelineOrchestratorSetAgentCapabilities: typeof trpc.pipelineOrchestrator.setAgentCapabilities.useMutation = trpc.pipelineOrchestrator.setAgentCapabilities.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setAgentDecodeLimits.useMutation`. */
export const usePipelineOrchestratorSetAgentDecodeLimits: typeof trpc.pipelineOrchestrator.setAgentDecodeLimits.useMutation = trpc.pipelineOrchestrator.setAgentDecodeLimits.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setAgentReachableHost.useMutation`. */
export const usePipelineOrchestratorSetAgentReachableHost: typeof trpc.pipelineOrchestrator.setAgentReachableHost.useMutation = trpc.pipelineOrchestrator.setAgentReachableHost.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setAgentInferenceDevices.useMutation`. */
export const usePipelineOrchestratorSetAgentInferenceDevices: typeof trpc.pipelineOrchestrator.setAgentInferenceDevices.useMutation = trpc.pipelineOrchestrator.setAgentInferenceDevices.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setNodeStepSettings.useMutation`. */
export const usePipelineOrchestratorSetNodeStepSettings: typeof trpc.pipelineOrchestrator.setNodeStepSettings.useMutation = trpc.pipelineOrchestrator.setNodeStepSettings.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getNodeInferenceDevices.useQuery`. */
export const usePipelineOrchestratorGetNodeInferenceDevices: typeof trpc.pipelineOrchestrator.getNodeInferenceDevices.useQuery = trpc.pipelineOrchestrator.getNodeInferenceDevices.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.forgetInferenceDevice.useMutation`. */
export const usePipelineOrchestratorForgetInferenceDevice: typeof trpc.pipelineOrchestrator.forgetInferenceDevice.useMutation = trpc.pipelineOrchestrator.forgetInferenceDevice.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.resetNodePipelineDefaults.useMutation`. */
export const usePipelineOrchestratorResetNodePipelineDefaults: typeof trpc.pipelineOrchestrator.resetNodePipelineDefaults.useMutation = trpc.pipelineOrchestrator.resetNodePipelineDefaults.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.planAutoTune.useQuery`. */
export const usePipelineOrchestratorPlanAutoTune: typeof trpc.pipelineOrchestrator.planAutoTune.useQuery = trpc.pipelineOrchestrator.planAutoTune.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.applyAutoTune.useMutation`. */
export const usePipelineOrchestratorApplyAutoTune: typeof trpc.pipelineOrchestrator.applyAutoTune.useMutation = trpc.pipelineOrchestrator.applyAutoTune.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setLoadBalancingShares.useMutation`. */
export const usePipelineOrchestratorSetLoadBalancingShares: typeof trpc.pipelineOrchestrator.setLoadBalancingShares.useMutation = trpc.pipelineOrchestrator.setLoadBalancingShares.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getPlacementStats.useQuery`. */
export const usePipelineOrchestratorGetPlacementStats: typeof trpc.pipelineOrchestrator.getPlacementStats.useQuery = trpc.pipelineOrchestrator.getPlacementStats.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.suggestShares.useQuery`. */
export const usePipelineOrchestratorSuggestShares: typeof trpc.pipelineOrchestrator.suggestShares.useQuery = trpc.pipelineOrchestrator.suggestShares.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getEffectiveShares.useQuery`. */
export const usePipelineOrchestratorGetEffectiveShares: typeof trpc.pipelineOrchestrator.getEffectiveShares.useQuery = trpc.pipelineOrchestrator.getEffectiveShares.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.setShareSource.useMutation`. */
export const usePipelineOrchestratorSetShareSource: typeof trpc.pipelineOrchestrator.setShareSource.useMutation = trpc.pipelineOrchestrator.setShareSource.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getNodeBenchmarkPreflight.useQuery`. */
export const usePipelineOrchestratorGetNodeBenchmarkPreflight: typeof trpc.pipelineOrchestrator.getNodeBenchmarkPreflight.useQuery = trpc.pipelineOrchestrator.getNodeBenchmarkPreflight.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.startNodeBenchmark.useMutation`. */
export const usePipelineOrchestratorStartNodeBenchmark: typeof trpc.pipelineOrchestrator.startNodeBenchmark.useMutation = trpc.pipelineOrchestrator.startNodeBenchmark.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getNodeBenchmarkStatus.useQuery`. */
export const usePipelineOrchestratorGetNodeBenchmarkStatus: typeof trpc.pipelineOrchestrator.getNodeBenchmarkStatus.useQuery = trpc.pipelineOrchestrator.getNodeBenchmarkStatus.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.abortNodeBenchmark.useMutation`. */
export const usePipelineOrchestratorAbortNodeBenchmark: typeof trpc.pipelineOrchestrator.abortNodeBenchmark.useMutation = trpc.pipelineOrchestrator.abortNodeBenchmark.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getNodeBenchmarkCandidates.useQuery`. */
export const usePipelineOrchestratorGetNodeBenchmarkCandidates: typeof trpc.pipelineOrchestrator.getNodeBenchmarkCandidates.useQuery = trpc.pipelineOrchestrator.getNodeBenchmarkCandidates.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.listNodeBenchmarkResults.useQuery`. */
export const usePipelineOrchestratorListNodeBenchmarkResults: typeof trpc.pipelineOrchestrator.listNodeBenchmarkResults.useQuery = trpc.pipelineOrchestrator.listNodeBenchmarkResults.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.deleteNodeBenchmarkResult.useMutation`. */
export const usePipelineOrchestratorDeleteNodeBenchmarkResult: typeof trpc.pipelineOrchestrator.deleteNodeBenchmarkResult.useMutation = trpc.pipelineOrchestrator.deleteNodeBenchmarkResult.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getCameraSettings.useQuery`. */
export const usePipelineOrchestratorGetCameraSettings: typeof trpc.pipelineOrchestrator.getCameraSettings.useQuery = trpc.pipelineOrchestrator.getCameraSettings.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.setCameraStepToggle.useMutation`. */
export const usePipelineOrchestratorSetCameraStepToggle: typeof trpc.pipelineOrchestrator.setCameraStepToggle.useMutation = trpc.pipelineOrchestrator.setCameraStepToggle.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getCameraDetectionSource.useQuery`. */
export const usePipelineOrchestratorGetCameraDetectionSource: typeof trpc.pipelineOrchestrator.getCameraDetectionSource.useQuery = trpc.pipelineOrchestrator.getCameraDetectionSource.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.setCameraDetectionSource.useMutation`. */
export const usePipelineOrchestratorSetCameraDetectionSource: typeof trpc.pipelineOrchestrator.setCameraDetectionSource.useMutation = trpc.pipelineOrchestrator.setCameraDetectionSource.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.setCameraStepSettings.useMutation`. */
export const usePipelineOrchestratorSetCameraStepSettings: typeof trpc.pipelineOrchestrator.setCameraStepSettings.useMutation = trpc.pipelineOrchestrator.setCameraStepSettings.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.resolvePipeline.useQuery`. */
export const usePipelineOrchestratorResolvePipeline: typeof trpc.pipelineOrchestrator.resolvePipeline.useQuery = trpc.pipelineOrchestrator.resolvePipeline.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getCameraSwitches.useQuery`. */
export const usePipelineOrchestratorGetCameraSwitches: typeof trpc.pipelineOrchestrator.getCameraSwitches.useQuery = trpc.pipelineOrchestrator.getCameraSwitches.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.setCameraSwitch.useMutation`. */
export const usePipelineOrchestratorSetCameraSwitch: typeof trpc.pipelineOrchestrator.setCameraSwitch.useMutation = trpc.pipelineOrchestrator.setCameraSwitch.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getCameraStatus.useQuery`. */
export const usePipelineOrchestratorGetCameraStatus: typeof trpc.pipelineOrchestrator.getCameraStatus.useQuery = trpc.pipelineOrchestrator.getCameraStatus.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getCameraStatuses.useQuery`. */
export const usePipelineOrchestratorGetCameraStatuses: typeof trpc.pipelineOrchestrator.getCameraStatuses.useQuery = trpc.pipelineOrchestrator.getCameraStatuses.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.setCameraSensors.useMutation`. */
export const usePipelineOrchestratorSetCameraSensors: typeof trpc.pipelineOrchestrator.setCameraSensors.useMutation = trpc.pipelineOrchestrator.setCameraSensors.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.reconcileFromDisk.useMutation`. */
export const usePipelineOrchestratorReconcileFromDisk: typeof trpc.pipelineOrchestrator.reconcileFromDisk.useMutation = trpc.pipelineOrchestrator.reconcileFromDisk.useMutation

/** Generated alias around `trpc.pipelineOrchestrator.getReconcileFromDiskStatus.useQuery`. */
export const usePipelineOrchestratorGetReconcileFromDiskStatus: typeof trpc.pipelineOrchestrator.getReconcileFromDiskStatus.useQuery = trpc.pipelineOrchestrator.getReconcileFromDiskStatus.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getDeviceSettingsContribution.useQuery`. */
export const usePipelineOrchestratorGetDeviceSettingsContribution: typeof trpc.pipelineOrchestrator.getDeviceSettingsContribution.useQuery = trpc.pipelineOrchestrator.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.getDeviceLiveContribution.useQuery`. */
export const usePipelineOrchestratorGetDeviceLiveContribution: typeof trpc.pipelineOrchestrator.getDeviceLiveContribution.useQuery = trpc.pipelineOrchestrator.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.pipelineOrchestrator.applyDeviceSettingsPatch.useMutation`. */
export const usePipelineOrchestratorApplyDeviceSettingsPatch: typeof trpc.pipelineOrchestrator.applyDeviceSettingsPatch.useMutation = trpc.pipelineOrchestrator.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.pipelineRunner.attachCamera.useMutation`. */
export const usePipelineRunnerAttachCamera: typeof trpc.pipelineRunner.attachCamera.useMutation = trpc.pipelineRunner.attachCamera.useMutation

/** Generated alias around `trpc.pipelineRunner.detachCamera.useMutation`. */
export const usePipelineRunnerDetachCamera: typeof trpc.pipelineRunner.detachCamera.useMutation = trpc.pipelineRunner.detachCamera.useMutation

/** Generated alias around `trpc.pipelineRunner.reportMotion.useMutation`. */
export const usePipelineRunnerReportMotion: typeof trpc.pipelineRunner.reportMotion.useMutation = trpc.pipelineRunner.reportMotion.useMutation

/** Generated alias around `trpc.pipelineRunner.getLocalLoad.useQuery`. */
export const usePipelineRunnerGetLocalLoad: typeof trpc.pipelineRunner.getLocalLoad.useQuery = trpc.pipelineRunner.getLocalLoad.useQuery

/** Generated alias around `trpc.pipelineRunner.getLocalMetrics.useQuery`. */
export const usePipelineRunnerGetLocalMetrics: typeof trpc.pipelineRunner.getLocalMetrics.useQuery = trpc.pipelineRunner.getLocalMetrics.useQuery

/** Generated alias around `trpc.pipelineRunner.getCameraMetrics.useQuery`. */
export const usePipelineRunnerGetCameraMetrics: typeof trpc.pipelineRunner.getCameraMetrics.useQuery = trpc.pipelineRunner.getCameraMetrics.useQuery

/** Generated alias around `trpc.pipelineRunner.getAllCameraMetrics.useQuery`. */
export const usePipelineRunnerGetAllCameraMetrics: typeof trpc.pipelineRunner.getAllCameraMetrics.useQuery = trpc.pipelineRunner.getAllCameraMetrics.useQuery

/** Generated alias around `trpc.pipelineRunner.getLocalCameras.useQuery`. */
export const usePipelineRunnerGetLocalCameras: typeof trpc.pipelineRunner.getLocalCameras.useQuery = trpc.pipelineRunner.getLocalCameras.useQuery

/** Generated alias around `trpc.pipelineRunner.requestOccupancyBurst.useMutation`. */
export const usePipelineRunnerRequestOccupancyBurst: typeof trpc.pipelineRunner.requestOccupancyBurst.useMutation = trpc.pipelineRunner.requestOccupancyBurst.useMutation

/** Generated alias around `trpc.pipelineRunner.getNativeCrop.useQuery`. */
export const usePipelineRunnerGetNativeCrop: typeof trpc.pipelineRunner.getNativeCrop.useQuery = trpc.pipelineRunner.getNativeCrop.useQuery

/** Generated alias around `trpc.pipelineRunner.runDetailSubtree.useMutation`. */
export const usePipelineRunnerRunDetailSubtree: typeof trpc.pipelineRunner.runDetailSubtree.useMutation = trpc.pipelineRunner.runDetailSubtree.useMutation

/** Generated alias around `trpc.pipelineRunner.runStatelessStep.useMutation`. */
export const usePipelineRunnerRunStatelessStep: typeof trpc.pipelineRunner.runStatelessStep.useMutation = trpc.pipelineRunner.runStatelessStep.useMutation

/** Generated alias around `trpc.pipelineRunner.parkTrackFrame.useMutation`. */
export const usePipelineRunnerParkTrackFrame: typeof trpc.pipelineRunner.parkTrackFrame.useMutation = trpc.pipelineRunner.parkTrackFrame.useMutation

/** Generated alias around `trpc.pipelineRunner.getParkedTrackFrame.useQuery`. */
export const usePipelineRunnerGetParkedTrackFrame: typeof trpc.pipelineRunner.getParkedTrackFrame.useQuery = trpc.pipelineRunner.getParkedTrackFrame.useQuery

/** Generated alias around `trpc.pipelineRunner.releaseParkedTrackFrames.useMutation`. */
export const usePipelineRunnerReleaseParkedTrackFrames: typeof trpc.pipelineRunner.releaseParkedTrackFrames.useMutation = trpc.pipelineRunner.releaseParkedTrackFrames.useMutation

/** Generated alias around `trpc.pipelineRunner.startNodeBench.useMutation`. */
export const usePipelineRunnerStartNodeBench: typeof trpc.pipelineRunner.startNodeBench.useMutation = trpc.pipelineRunner.startNodeBench.useMutation

/** Generated alias around `trpc.pipelineRunner.getNodeBenchStatus.useQuery`. */
export const usePipelineRunnerGetNodeBenchStatus: typeof trpc.pipelineRunner.getNodeBenchStatus.useQuery = trpc.pipelineRunner.getNodeBenchStatus.useQuery

/** Generated alias around `trpc.pipelineRunner.abortNodeBench.useMutation`. */
export const usePipelineRunnerAbortNodeBench: typeof trpc.pipelineRunner.abortNodeBench.useMutation = trpc.pipelineRunner.abortNodeBench.useMutation

/** Generated alias around `trpc.plateGallery.listPlates.useQuery`. */
export const usePlateGalleryListPlates: typeof trpc.plateGallery.listPlates.useQuery = trpc.plateGallery.listPlates.useQuery

/** Generated alias around `trpc.plateGallery.getPlateByTrack.useQuery`. */
export const usePlateGalleryGetPlateByTrack: typeof trpc.plateGallery.getPlateByTrack.useQuery = trpc.plateGallery.getPlateByTrack.useQuery

/** Generated alias around `trpc.plateGallery.getPlateMedia.useQuery`. */
export const usePlateGalleryGetPlateMedia: typeof trpc.plateGallery.getPlateMedia.useQuery = trpc.plateGallery.getPlateMedia.useQuery

/** Generated alias around `trpc.plateGallery.searchPlates.useQuery`. */
export const usePlateGallerySearchPlates: typeof trpc.plateGallery.searchPlates.useQuery = trpc.plateGallery.searchPlates.useQuery

/** Generated alias around `trpc.plateGallery.suggestPlateClusters.useQuery`. */
export const usePlateGallerySuggestPlateClusters: typeof trpc.plateGallery.suggestPlateClusters.useQuery = trpc.plateGallery.suggestPlateClusters.useQuery

/** Generated alias around `trpc.plateGallery.correctPlateText.useMutation`. */
export const usePlateGalleryCorrectPlateText: typeof trpc.plateGallery.correctPlateText.useMutation = trpc.plateGallery.correctPlateText.useMutation

/** Generated alias around `trpc.plateGallery.deletePlate.useMutation`. */
export const usePlateGalleryDeletePlate: typeof trpc.plateGallery.deletePlate.useMutation = trpc.plateGallery.deletePlate.useMutation

/** Generated alias around `trpc.plateGallery.listVehicles.useQuery`. */
export const usePlateGalleryListVehicles: typeof trpc.plateGallery.listVehicles.useQuery = trpc.plateGallery.listVehicles.useQuery

/** Generated alias around `trpc.plateGallery.createVehicle.useMutation`. */
export const usePlateGalleryCreateVehicle: typeof trpc.plateGallery.createVehicle.useMutation = trpc.plateGallery.createVehicle.useMutation

/** Generated alias around `trpc.plateGallery.renameVehicle.useMutation`. */
export const usePlateGalleryRenameVehicle: typeof trpc.plateGallery.renameVehicle.useMutation = trpc.plateGallery.renameVehicle.useMutation

/** Generated alias around `trpc.plateGallery.deleteVehicle.useMutation`. */
export const usePlateGalleryDeleteVehicle: typeof trpc.plateGallery.deleteVehicle.useMutation = trpc.plateGallery.deleteVehicle.useMutation

/** Generated alias around `trpc.plateGallery.listVehicleSamples.useQuery`. */
export const usePlateGalleryListVehicleSamples: typeof trpc.plateGallery.listVehicleSamples.useQuery = trpc.plateGallery.listVehicleSamples.useQuery

/** Generated alias around `trpc.plateGallery.removeVehicleSample.useMutation`. */
export const usePlateGalleryRemoveVehicleSample: typeof trpc.plateGallery.removeVehicleSample.useMutation = trpc.plateGallery.removeVehicleSample.useMutation

/** Generated alias around `trpc.plateGallery.assignPlate.useMutation`. */
export const usePlateGalleryAssignPlate: typeof trpc.plateGallery.assignPlate.useMutation = trpc.plateGallery.assignPlate.useMutation

/** Generated alias around `trpc.plateGallery.unassignPlate.useMutation`. */
export const usePlateGalleryUnassignPlate: typeof trpc.plateGallery.unassignPlate.useMutation = trpc.plateGallery.unassignPlate.useMutation

/** Generated alias around `trpc.plateGallery.assignPlates.useMutation`. */
export const usePlateGalleryAssignPlates: typeof trpc.plateGallery.assignPlates.useMutation = trpc.plateGallery.assignPlates.useMutation

/** Generated alias around `trpc.plateGallery.unassignPlates.useMutation`. */
export const usePlateGalleryUnassignPlates: typeof trpc.plateGallery.unassignPlates.useMutation = trpc.plateGallery.unassignPlates.useMutation

/** Generated alias around `trpc.powerMeter.getStatus.useQuery`. */
export const usePowerMeterGetStatus: typeof trpc.powerMeter.getStatus.useQuery = trpc.powerMeter.getStatus.useQuery

/** Generated alias around `trpc.presence.getStatus.useQuery`. */
export const usePresenceGetStatus: typeof trpc.presence.getStatus.useQuery = trpc.presence.getStatus.useQuery

/** Generated alias around `trpc.pressureSensor.getStatus.useQuery`. */
export const usePressureSensorGetStatus: typeof trpc.pressureSensor.getStatus.useQuery = trpc.pressureSensor.getStatus.useQuery

/** Generated alias around `trpc.privacyMask.getOptions.useQuery`. */
export const usePrivacyMaskGetOptions: typeof trpc.privacyMask.getOptions.useQuery = trpc.privacyMask.getOptions.useQuery

/** Generated alias around `trpc.privacyMask.setMask.useMutation`. */
export const usePrivacyMaskSetMask: typeof trpc.privacyMask.setMask.useMutation = trpc.privacyMask.setMask.useMutation

/** Generated alias around `trpc.privacyMask.setAudioEnabled.useMutation`. */
export const usePrivacyMaskSetAudioEnabled: typeof trpc.privacyMask.setAudioEnabled.useMutation = trpc.privacyMask.setAudioEnabled.useMutation

/** Generated alias around `trpc.privacyMask.getStatus.useQuery`. */
export const usePrivacyMaskGetStatus: typeof trpc.privacyMask.getStatus.useQuery = trpc.privacyMask.getStatus.useQuery

/** Generated alias around `trpc.ptz.move.useMutation`. */
export const usePtzMove: typeof trpc.ptz.move.useMutation = trpc.ptz.move.useMutation

/** Generated alias around `trpc.ptz.continuousMove.useMutation`. */
export const usePtzContinuousMove: typeof trpc.ptz.continuousMove.useMutation = trpc.ptz.continuousMove.useMutation

/** Generated alias around `trpc.ptz.stop.useMutation`. */
export const usePtzStop: typeof trpc.ptz.stop.useMutation = trpc.ptz.stop.useMutation

/** Generated alias around `trpc.ptz.getPresets.useQuery`. */
export const usePtzGetPresets: typeof trpc.ptz.getPresets.useQuery = trpc.ptz.getPresets.useQuery

/** Generated alias around `trpc.ptz.goToPreset.useMutation`. */
export const usePtzGoToPreset: typeof trpc.ptz.goToPreset.useMutation = trpc.ptz.goToPreset.useMutation

/** Generated alias around `trpc.ptz.savePreset.useMutation`. */
export const usePtzSavePreset: typeof trpc.ptz.savePreset.useMutation = trpc.ptz.savePreset.useMutation

/** Generated alias around `trpc.ptz.deletePreset.useMutation`. */
export const usePtzDeletePreset: typeof trpc.ptz.deletePreset.useMutation = trpc.ptz.deletePreset.useMutation

/** Generated alias around `trpc.ptz.getOptions.useQuery`. */
export const usePtzGetOptions: typeof trpc.ptz.getOptions.useQuery = trpc.ptz.getOptions.useQuery

/** Generated alias around `trpc.ptz.goHome.useMutation`. */
export const usePtzGoHome: typeof trpc.ptz.goHome.useMutation = trpc.ptz.goHome.useMutation

/** Generated alias around `trpc.ptz.getHomePreset.useQuery`. */
export const usePtzGetHomePreset: typeof trpc.ptz.getHomePreset.useQuery = trpc.ptz.getHomePreset.useQuery

/** Generated alias around `trpc.ptz.setHomePreset.useMutation`. */
export const usePtzSetHomePreset: typeof trpc.ptz.setHomePreset.useMutation = trpc.ptz.setHomePreset.useMutation

/** Generated alias around `trpc.ptz.captureHomeHere.useMutation`. */
export const usePtzCaptureHomeHere: typeof trpc.ptz.captureHomeHere.useMutation = trpc.ptz.captureHomeHere.useMutation

/** Generated alias around `trpc.ptz.getHomeReturn.useQuery`. */
export const usePtzGetHomeReturn: typeof trpc.ptz.getHomeReturn.useQuery = trpc.ptz.getHomeReturn.useQuery

/** Generated alias around `trpc.ptz.setHomeReturn.useMutation`. */
export const usePtzSetHomeReturn: typeof trpc.ptz.setHomeReturn.useMutation = trpc.ptz.setHomeReturn.useMutation

/** Generated alias around `trpc.ptz.getPosition.useQuery`. */
export const usePtzGetPosition: typeof trpc.ptz.getPosition.useQuery = trpc.ptz.getPosition.useQuery

/** Generated alias around `trpc.ptz.setAutofocus.useMutation`. */
export const usePtzSetAutofocus: typeof trpc.ptz.setAutofocus.useMutation = trpc.ptz.setAutofocus.useMutation

/** Generated alias around `trpc.ptz.getStatus.useQuery`. */
export const usePtzGetStatus: typeof trpc.ptz.getStatus.useQuery = trpc.ptz.getStatus.useQuery

/** Generated alias around `trpc.ptzAutotrack.getStatus.useQuery`. */
export const usePtzAutotrackGetStatus: typeof trpc.ptzAutotrack.getStatus.useQuery = trpc.ptzAutotrack.getStatus.useQuery

/** Generated alias around `trpc.ptzAutotrack.setEnabled.useMutation`. */
export const usePtzAutotrackSetEnabled: typeof trpc.ptzAutotrack.setEnabled.useMutation = trpc.ptzAutotrack.setEnabled.useMutation

/** Generated alias around `trpc.ptzAutotrack.getSettings.useQuery`. */
export const usePtzAutotrackGetSettings: typeof trpc.ptzAutotrack.getSettings.useQuery = trpc.ptzAutotrack.getSettings.useQuery

/** Generated alias around `trpc.ptzAutotrack.setSettings.useMutation`. */
export const usePtzAutotrackSetSettings: typeof trpc.ptzAutotrack.setSettings.useMutation = trpc.ptzAutotrack.setSettings.useMutation

/** Generated alias around `trpc.reboot.reboot.useMutation`. */
export const useRebootReboot: typeof trpc.reboot.reboot.useMutation = trpc.reboot.reboot.useMutation

/** Generated alias around `trpc.recordEntries.listEntryKinds.useQuery`. */
export const useRecordEntriesListEntryKinds: typeof trpc.recordEntries.listEntryKinds.useQuery = trpc.recordEntries.listEntryKinds.useQuery

/** Generated alias around `trpc.recordEntries.listEntries.useQuery`. */
export const useRecordEntriesListEntries: typeof trpc.recordEntries.listEntries.useQuery = trpc.recordEntries.listEntries.useQuery

/** Generated alias around `trpc.recordEntries.putEntry.useMutation`. */
export const useRecordEntriesPutEntry: typeof trpc.recordEntries.putEntry.useMutation = trpc.recordEntries.putEntry.useMutation

/** Generated alias around `trpc.recordEntries.deleteEntry.useMutation`. */
export const useRecordEntriesDeleteEntry: typeof trpc.recordEntries.deleteEntry.useMutation = trpc.recordEntries.deleteEntry.useMutation

/** Generated alias around `trpc.recording.listSources.useQuery`. */
export const useRecordingListSources: typeof trpc.recording.listSources.useQuery = trpc.recording.listSources.useQuery

/** Generated alias around `trpc.recording.getAvailability.useQuery`. */
export const useRecordingGetAvailability: typeof trpc.recording.getAvailability.useQuery = trpc.recording.getAvailability.useQuery

/** Generated alias around `trpc.recording.getDaysWithRecordings.useQuery`. */
export const useRecordingGetDaysWithRecordings: typeof trpc.recording.getDaysWithRecordings.useQuery = trpc.recording.getDaysWithRecordings.useQuery

/** Generated alias around `trpc.recording.getPlayback.useQuery`. */
export const useRecordingGetPlayback: typeof trpc.recording.getPlayback.useQuery = trpc.recording.getPlayback.useQuery

/** Generated alias around `trpc.recording.getPlaybackOptions.useQuery`. */
export const useRecordingGetPlaybackOptions: typeof trpc.recording.getPlaybackOptions.useQuery = trpc.recording.getPlaybackOptions.useQuery

/** Generated alias around `trpc.recordingArchive.getAvailabilityBatch.useQuery`. */
export const useRecordingArchiveGetAvailabilityBatch: typeof trpc.recordingArchive.getAvailabilityBatch.useQuery = trpc.recordingArchive.getAvailabilityBatch.useQuery

/** Generated alias around `trpc.recordingArchive.getDaysWithRecordingsBatch.useQuery`. */
export const useRecordingArchiveGetDaysWithRecordingsBatch: typeof trpc.recordingArchive.getDaysWithRecordingsBatch.useQuery = trpc.recordingArchive.getDaysWithRecordingsBatch.useQuery

/** Generated alias around `trpc.recordingArchive.getStorageUsage.useQuery`. */
export const useRecordingArchiveGetStorageUsage: typeof trpc.recordingArchive.getStorageUsage.useQuery = trpc.recordingArchive.getStorageUsage.useQuery

/** Generated alias around `trpc.recordingArchive.getDeviceConfig.useQuery`. */
export const useRecordingArchiveGetDeviceConfig: typeof trpc.recordingArchive.getDeviceConfig.useQuery = trpc.recordingArchive.getDeviceConfig.useQuery

/** Generated alias around `trpc.recordingArchive.locateSegment.useQuery`. */
export const useRecordingArchiveLocateSegment: typeof trpc.recordingArchive.locateSegment.useQuery = trpc.recordingArchive.locateSegment.useQuery

/** Generated alias around `trpc.recordingArchive.readSegmentBytes.useQuery`. */
export const useRecordingArchiveReadSegmentBytes: typeof trpc.recordingArchive.readSegmentBytes.useQuery = trpc.recordingArchive.readSegmentBytes.useQuery

/** Generated alias around `trpc.recordingArchive.readGopBytes.useQuery`. */
export const useRecordingArchiveReadGopBytes: typeof trpc.recordingArchive.readGopBytes.useQuery = trpc.recordingArchive.readGopBytes.useQuery

/** Generated alias around `trpc.recordingArchive.readWindowBytes.useQuery`. */
export const useRecordingArchiveReadWindowBytes: typeof trpc.recordingArchive.readWindowBytes.useQuery = trpc.recordingArchive.readWindowBytes.useQuery

/** Generated alias around `trpc.recordingArchive.setDeviceConfig.useMutation`. */
export const useRecordingArchiveSetDeviceConfig: typeof trpc.recordingArchive.setDeviceConfig.useMutation = trpc.recordingArchive.setDeviceConfig.useMutation

/** Generated alias around `trpc.recordingArchive.rescanStorage.useMutation`. */
export const useRecordingArchiveRescanStorage: typeof trpc.recordingArchive.rescanStorage.useMutation = trpc.recordingArchive.rescanStorage.useMutation

/** Generated alias around `trpc.recordingArchive.pruneFootage.useMutation`. */
export const useRecordingArchivePruneFootage: typeof trpc.recordingArchive.pruneFootage.useMutation = trpc.recordingArchive.pruneFootage.useMutation

/** Generated alias around `trpc.recordingArchive.deleteFootprint.useMutation`. */
export const useRecordingArchiveDeleteFootprint: typeof trpc.recordingArchive.deleteFootprint.useMutation = trpc.recordingArchive.deleteFootprint.useMutation

/** Generated alias around `trpc.recordingArchive.listOpsLog.useQuery`. */
export const useRecordingArchiveListOpsLog: typeof trpc.recordingArchive.listOpsLog.useQuery = trpc.recordingArchive.listOpsLog.useQuery

/** Generated alias around `trpc.recordingArchive.renderGif.useMutation`. */
export const useRecordingArchiveRenderGif: typeof trpc.recordingArchive.renderGif.useMutation = trpc.recordingArchive.renderGif.useMutation

/** Generated alias around `trpc.recordingArchive.renderClip.useMutation`. */
export const useRecordingArchiveRenderClip: typeof trpc.recordingArchive.renderClip.useMutation = trpc.recordingArchive.renderClip.useMutation

/** Generated alias around `trpc.recordingArchive.pauseForStorageMigration.useMutation`. */
export const useRecordingArchivePauseForStorageMigration: typeof trpc.recordingArchive.pauseForStorageMigration.useMutation = trpc.recordingArchive.pauseForStorageMigration.useMutation

/** Generated alias around `trpc.recordingArchive.resumeForStorageMigration.useMutation`. */
export const useRecordingArchiveResumeForStorageMigration: typeof trpc.recordingArchive.resumeForStorageMigration.useMutation = trpc.recordingArchive.resumeForStorageMigration.useMutation

/** Generated alias around `trpc.recordingArchive.refreshStorageLocationsForMigration.useMutation`. */
export const useRecordingArchiveRefreshStorageLocationsForMigration: typeof trpc.recordingArchive.refreshStorageLocationsForMigration.useMutation = trpc.recordingArchive.refreshStorageLocationsForMigration.useMutation

/** Generated alias around `trpc.recordingArchive.startStorageMigrationMove.useMutation`. */
export const useRecordingArchiveStartStorageMigrationMove: typeof trpc.recordingArchive.startStorageMigrationMove.useMutation = trpc.recordingArchive.startStorageMigrationMove.useMutation

/** Generated alias around `trpc.recordingArchive.getStorageMigrationMoveStatus.useQuery`. */
export const useRecordingArchiveGetStorageMigrationMoveStatus: typeof trpc.recordingArchive.getStorageMigrationMoveStatus.useQuery = trpc.recordingArchive.getStorageMigrationMoveStatus.useQuery

/** Generated alias around `trpc.recordingArchive.cancelStorageMigrationMove.useMutation`. */
export const useRecordingArchiveCancelStorageMigrationMove: typeof trpc.recordingArchive.cancelStorageMigrationMove.useMutation = trpc.recordingArchive.cancelStorageMigrationMove.useMutation

/** Generated alias around `trpc.recordingArchive.relocateFootage.useMutation`. */
export const useRecordingArchiveRelocateFootage: typeof trpc.recordingArchive.relocateFootage.useMutation = trpc.recordingArchive.relocateFootage.useMutation

/** Generated alias around `trpc.recordingArchive.listRelocateJobs.useQuery`. */
export const useRecordingArchiveListRelocateJobs: typeof trpc.recordingArchive.listRelocateJobs.useQuery = trpc.recordingArchive.listRelocateJobs.useQuery

/** Generated alias around `trpc.recordingArchive.getRelocateResidue.useQuery`. */
export const useRecordingArchiveGetRelocateResidue: typeof trpc.recordingArchive.getRelocateResidue.useQuery = trpc.recordingArchive.getRelocateResidue.useQuery

/** Generated alias around `trpc.recordingArchive.reconcileLedgerAgainstDisk.useMutation`. */
export const useRecordingArchiveReconcileLedgerAgainstDisk: typeof trpc.recordingArchive.reconcileLedgerAgainstDisk.useMutation = trpc.recordingArchive.reconcileLedgerAgainstDisk.useMutation

/** Generated alias around `trpc.recordingArchive.cancelRelocateJob.useMutation`. */
export const useRecordingArchiveCancelRelocateJob: typeof trpc.recordingArchive.cancelRelocateJob.useMutation = trpc.recordingArchive.cancelRelocateJob.useMutation

/** Generated alias around `trpc.recordingArchive.planStorageRebalance.useQuery`. */
export const useRecordingArchivePlanStorageRebalance: typeof trpc.recordingArchive.planStorageRebalance.useQuery = trpc.recordingArchive.planStorageRebalance.useQuery

/** Generated alias around `trpc.recordingArchive.startStorageRebalance.useMutation`. */
export const useRecordingArchiveStartStorageRebalance: typeof trpc.recordingArchive.startStorageRebalance.useMutation = trpc.recordingArchive.startStorageRebalance.useMutation

/** Generated alias around `trpc.recordingArchive.getPlacement.useQuery`. */
export const useRecordingArchiveGetPlacement: typeof trpc.recordingArchive.getPlacement.useQuery = trpc.recordingArchive.getPlacement.useQuery

/** Generated alias around `trpc.recordingArchive.setDevicePlacement.useMutation`. */
export const useRecordingArchiveSetDevicePlacement: typeof trpc.recordingArchive.setDevicePlacement.useMutation = trpc.recordingArchive.setDevicePlacement.useMutation

/** Generated alias around `trpc.recordingArchive.getStatus.useQuery`. */
export const useRecordingArchiveGetStatus: typeof trpc.recordingArchive.getStatus.useQuery = trpc.recordingArchive.getStatus.useQuery

/** Generated alias around `trpc.recordingArchive.getDeviceSettingsContribution.useQuery`. */
export const useRecordingArchiveGetDeviceSettingsContribution: typeof trpc.recordingArchive.getDeviceSettingsContribution.useQuery = trpc.recordingArchive.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.recordingArchive.getDeviceLiveContribution.useQuery`. */
export const useRecordingArchiveGetDeviceLiveContribution: typeof trpc.recordingArchive.getDeviceLiveContribution.useQuery = trpc.recordingArchive.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.recordingArchive.applyDeviceSettingsPatch.useMutation`. */
export const useRecordingArchiveApplyDeviceSettingsPatch: typeof trpc.recordingArchive.applyDeviceSettingsPatch.useMutation = trpc.recordingArchive.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.recordingExport.createExport.useMutation`. */
export const useRecordingExportCreateExport: typeof trpc.recordingExport.createExport.useMutation = trpc.recordingExport.createExport.useMutation

/** Generated alias around `trpc.recordingExport.listExports.useQuery`. */
export const useRecordingExportListExports: typeof trpc.recordingExport.listExports.useQuery = trpc.recordingExport.listExports.useQuery

/** Generated alias around `trpc.recordingExport.getExport.useQuery`. */
export const useRecordingExportGetExport: typeof trpc.recordingExport.getExport.useQuery = trpc.recordingExport.getExport.useQuery

/** Generated alias around `trpc.recordingExport.cancelExport.useMutation`. */
export const useRecordingExportCancelExport: typeof trpc.recordingExport.cancelExport.useMutation = trpc.recordingExport.cancelExport.useMutation

/** Generated alias around `trpc.recordingExport.deleteExport.useMutation`. */
export const useRecordingExportDeleteExport: typeof trpc.recordingExport.deleteExport.useMutation = trpc.recordingExport.deleteExport.useMutation

/** Generated alias around `trpc.recordingExport.getDownloadUrl.useQuery`. */
export const useRecordingExportGetDownloadUrl: typeof trpc.recordingExport.getDownloadUrl.useQuery = trpc.recordingExport.getDownloadUrl.useQuery

/** Generated alias around `trpc.recordingExport.readExportBytes.useQuery`. */
export const useRecordingExportReadExportBytes: typeof trpc.recordingExport.readExportBytes.useQuery = trpc.recordingExport.readExportBytes.useQuery

/** Generated alias around `trpc.recordingOnboard.getOptions.useQuery`. */
export const useRecordingOnboardGetOptions: typeof trpc.recordingOnboard.getOptions.useQuery = trpc.recordingOnboard.getOptions.useQuery

/** Generated alias around `trpc.recordingOnboard.setSettings.useMutation`. */
export const useRecordingOnboardSetSettings: typeof trpc.recordingOnboard.setSettings.useMutation = trpc.recordingOnboard.setSettings.useMutation

/** Generated alias around `trpc.recordingOnboard.getStatus.useQuery`. */
export const useRecordingOnboardGetStatus: typeof trpc.recordingOnboard.getStatus.useQuery = trpc.recordingOnboard.getStatus.useQuery

/** Generated alias around `trpc.recordingSignal.getStatus.useQuery`. */
export const useRecordingSignalGetStatus: typeof trpc.recordingSignal.getStatus.useQuery = trpc.recordingSignal.getStatus.useQuery

/** Generated alias around `trpc.runningState.getStatus.useQuery`. */
export const useRunningStateGetStatus: typeof trpc.runningState.getStatus.useQuery = trpc.runningState.getStatus.useQuery

/** Generated alias around `trpc.sceneMonitor.listScenes.useQuery`. */
export const useSceneMonitorListScenes: typeof trpc.sceneMonitor.listScenes.useQuery = trpc.sceneMonitor.listScenes.useQuery

/** Generated alias around `trpc.sceneMonitor.listScenesBatch.useQuery`. */
export const useSceneMonitorListScenesBatch: typeof trpc.sceneMonitor.listScenesBatch.useQuery = trpc.sceneMonitor.listScenesBatch.useQuery

/** Generated alias around `trpc.sceneMonitor.createScene.useMutation`. */
export const useSceneMonitorCreateScene: typeof trpc.sceneMonitor.createScene.useMutation = trpc.sceneMonitor.createScene.useMutation

/** Generated alias around `trpc.sceneMonitor.updateScene.useMutation`. */
export const useSceneMonitorUpdateScene: typeof trpc.sceneMonitor.updateScene.useMutation = trpc.sceneMonitor.updateScene.useMutation

/** Generated alias around `trpc.sceneMonitor.deleteScene.useMutation`. */
export const useSceneMonitorDeleteScene: typeof trpc.sceneMonitor.deleteScene.useMutation = trpc.sceneMonitor.deleteScene.useMutation

/** Generated alias around `trpc.sceneMonitor.captureReference.useMutation`. */
export const useSceneMonitorCaptureReference: typeof trpc.sceneMonitor.captureReference.useMutation = trpc.sceneMonitor.captureReference.useMutation

/** Generated alias around `trpc.sceneMonitor.deleteReference.useMutation`. */
export const useSceneMonitorDeleteReference: typeof trpc.sceneMonitor.deleteReference.useMutation = trpc.sceneMonitor.deleteReference.useMutation

/** Generated alias around `trpc.sceneMonitor.recheckNow.useMutation`. */
export const useSceneMonitorRecheckNow: typeof trpc.sceneMonitor.recheckNow.useMutation = trpc.sceneMonitor.recheckNow.useMutation

/** Generated alias around `trpc.sceneMonitor.resetScene.useMutation`. */
export const useSceneMonitorResetScene: typeof trpc.sceneMonitor.resetScene.useMutation = trpc.sceneMonitor.resetScene.useMutation

/** Generated alias around `trpc.sceneMonitor.getStatus.useQuery`. */
export const useSceneMonitorGetStatus: typeof trpc.sceneMonitor.getStatus.useQuery = trpc.sceneMonitor.getStatus.useQuery

/** Generated alias around `trpc.scriptRunner.run.useMutation`. */
export const useScriptRunnerRun: typeof trpc.scriptRunner.run.useMutation = trpc.scriptRunner.run.useMutation

/** Generated alias around `trpc.scriptRunner.stop.useMutation`. */
export const useScriptRunnerStop: typeof trpc.scriptRunner.stop.useMutation = trpc.scriptRunner.stop.useMutation

/** Generated alias around `trpc.scriptRunner.getStatus.useQuery`. */
export const useScriptRunnerGetStatus: typeof trpc.scriptRunner.getStatus.useQuery = trpc.scriptRunner.getStatus.useQuery

/** Generated alias around `trpc.serverManagement.getServerPackageStatus.useQuery`. */
export const useServerManagementGetServerPackageStatus: typeof trpc.serverManagement.getServerPackageStatus.useQuery = trpc.serverManagement.getServerPackageStatus.useQuery

/** Generated alias around `trpc.serverManagement.checkServerUpdate.useMutation`. */
export const useServerManagementCheckServerUpdate: typeof trpc.serverManagement.checkServerUpdate.useMutation = trpc.serverManagement.checkServerUpdate.useMutation

/** Generated alias around `trpc.serverManagement.applyServerUpdate.useMutation`. */
export const useServerManagementApplyServerUpdate: typeof trpc.serverManagement.applyServerUpdate.useMutation = trpc.serverManagement.applyServerUpdate.useMutation

/** Generated alias around `trpc.serverManagement.rollbackServerUpdate.useMutation`. */
export const useServerManagementRollbackServerUpdate: typeof trpc.serverManagement.rollbackServerUpdate.useMutation = trpc.serverManagement.rollbackServerUpdate.useMutation

/** Generated alias around `trpc.serverManagement.restartServer.useMutation`. */
export const useServerManagementRestartServer: typeof trpc.serverManagement.restartServer.useMutation = trpc.serverManagement.restartServer.useMutation

/** Generated alias around `trpc.settingsStore.get.useQuery`. */
export const useSettingsStoreGet: typeof trpc.settingsStore.get.useQuery = trpc.settingsStore.get.useQuery

/** Generated alias around `trpc.settingsStore.set.useMutation`. */
export const useSettingsStoreSet: typeof trpc.settingsStore.set.useMutation = trpc.settingsStore.set.useMutation

/** Generated alias around `trpc.settingsStore.query.useQuery`. */
export const useSettingsStoreQuery: typeof trpc.settingsStore.query.useQuery = trpc.settingsStore.query.useQuery

/** Generated alias around `trpc.settingsStore.upsert.useMutation`. */
export const useSettingsStoreUpsert: typeof trpc.settingsStore.upsert.useMutation = trpc.settingsStore.upsert.useMutation

/** Generated alias around `trpc.settingsStore.upsertMany.useMutation`. */
export const useSettingsStoreUpsertMany: typeof trpc.settingsStore.upsertMany.useMutation = trpc.settingsStore.upsertMany.useMutation

/** Generated alias around `trpc.settingsStore.insert.useMutation`. */
export const useSettingsStoreInsert: typeof trpc.settingsStore.insert.useMutation = trpc.settingsStore.insert.useMutation

/** Generated alias around `trpc.settingsStore.insertMany.useMutation`. */
export const useSettingsStoreInsertMany: typeof trpc.settingsStore.insertMany.useMutation = trpc.settingsStore.insertMany.useMutation

/** Generated alias around `trpc.settingsStore.transact.useMutation`. */
export const useSettingsStoreTransact: typeof trpc.settingsStore.transact.useMutation = trpc.settingsStore.transact.useMutation

/** Generated alias around `trpc.settingsStore.update.useMutation`. */
export const useSettingsStoreUpdate: typeof trpc.settingsStore.update.useMutation = trpc.settingsStore.update.useMutation

/** Generated alias around `trpc.settingsStore.delete.useMutation`. */
export const useSettingsStoreDelete: typeof trpc.settingsStore.delete.useMutation = trpc.settingsStore.delete.useMutation

/** Generated alias around `trpc.settingsStore.deleteWhere.useMutation`. */
export const useSettingsStoreDeleteWhere: typeof trpc.settingsStore.deleteWhere.useMutation = trpc.settingsStore.deleteWhere.useMutation

/** Generated alias around `trpc.settingsStore.updateWhere.useMutation`. */
export const useSettingsStoreUpdateWhere: typeof trpc.settingsStore.updateWhere.useMutation = trpc.settingsStore.updateWhere.useMutation

/** Generated alias around `trpc.settingsStore.count.useQuery`. */
export const useSettingsStoreCount: typeof trpc.settingsStore.count.useQuery = trpc.settingsStore.count.useQuery

/** Generated alias around `trpc.settingsStore.aggregate.useQuery`. */
export const useSettingsStoreAggregate: typeof trpc.settingsStore.aggregate.useQuery = trpc.settingsStore.aggregate.useQuery

/** Generated alias around `trpc.settingsStore.histogram.useQuery`. */
export const useSettingsStoreHistogram: typeof trpc.settingsStore.histogram.useQuery = trpc.settingsStore.histogram.useQuery

/** Generated alias around `trpc.settingsStore.isEmpty.useQuery`. */
export const useSettingsStoreIsEmpty: typeof trpc.settingsStore.isEmpty.useQuery = trpc.settingsStore.isEmpty.useQuery

/** Generated alias around `trpc.settingsStore.declareCollection.useMutation`. */
export const useSettingsStoreDeclareCollection: typeof trpc.settingsStore.declareCollection.useMutation = trpc.settingsStore.declareCollection.useMutation

/** Generated alias around `trpc.smoke.getStatus.useQuery`. */
export const useSmokeGetStatus: typeof trpc.smoke.getStatus.useQuery = trpc.smoke.getStatus.useQuery

/** Generated alias around `trpc.snapshot.getSnapshot.useQuery`. */
export const useSnapshotGetSnapshot: typeof trpc.snapshot.getSnapshot.useQuery = trpc.snapshot.getSnapshot.useQuery

/** Generated alias around `trpc.snapshot.invalidateCache.useMutation`. */
export const useSnapshotInvalidateCache: typeof trpc.snapshot.invalidateCache.useMutation = trpc.snapshot.invalidateCache.useMutation

/** Generated alias around `trpc.snapshot.getSnapshotOverview.useQuery`. */
export const useSnapshotGetSnapshotOverview: typeof trpc.snapshot.getSnapshotOverview.useQuery = trpc.snapshot.getSnapshotOverview.useQuery

/** Generated alias around `trpc.snapshot.getDebugState.useQuery`. */
export const useSnapshotGetDebugState: typeof trpc.snapshot.getDebugState.useQuery = trpc.snapshot.getDebugState.useQuery

/** Generated alias around `trpc.snapshot.getSnapshotLinks.useQuery`. */
export const useSnapshotGetSnapshotLinks: typeof trpc.snapshot.getSnapshotLinks.useQuery = trpc.snapshot.getSnapshotLinks.useQuery

/** Generated alias around `trpc.snapshot.getStatus.useQuery`. */
export const useSnapshotGetStatus: typeof trpc.snapshot.getStatus.useQuery = trpc.snapshot.getStatus.useQuery

/** Generated alias around `trpc.snapshot.getDeviceSettingsContribution.useQuery`. */
export const useSnapshotGetDeviceSettingsContribution: typeof trpc.snapshot.getDeviceSettingsContribution.useQuery = trpc.snapshot.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.snapshot.getDeviceLiveContribution.useQuery`. */
export const useSnapshotGetDeviceLiveContribution: typeof trpc.snapshot.getDeviceLiveContribution.useQuery = trpc.snapshot.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.snapshot.applyDeviceSettingsPatch.useMutation`. */
export const useSnapshotApplyDeviceSettingsPatch: typeof trpc.snapshot.applyDeviceSettingsPatch.useMutation = trpc.snapshot.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.storage.resolve.useQuery`. */
export const useStorageResolve: typeof trpc.storage.resolve.useQuery = trpc.storage.resolve.useQuery

/** Generated alias around `trpc.storage.write.useMutation`. */
export const useStorageWrite: typeof trpc.storage.write.useMutation = trpc.storage.write.useMutation

/** Generated alias around `trpc.storage.read.useQuery`. */
export const useStorageRead: typeof trpc.storage.read.useQuery = trpc.storage.read.useQuery

/** Generated alias around `trpc.storage.exists.useQuery`. */
export const useStorageExists: typeof trpc.storage.exists.useQuery = trpc.storage.exists.useQuery

/** Generated alias around `trpc.storage.list.useQuery`. */
export const useStorageList: typeof trpc.storage.list.useQuery = trpc.storage.list.useQuery

/** Generated alias around `trpc.storage.delete.useMutation`. */
export const useStorageDelete: typeof trpc.storage.delete.useMutation = trpc.storage.delete.useMutation

/** Generated alias around `trpc.storage.getAvailableSpace.useQuery`. */
export const useStorageGetAvailableSpace: typeof trpc.storage.getAvailableSpace.useQuery = trpc.storage.getAvailableSpace.useQuery

/** Generated alias around `trpc.storage.beginUpload.useMutation`. */
export const useStorageBeginUpload: typeof trpc.storage.beginUpload.useMutation = trpc.storage.beginUpload.useMutation

/** Generated alias around `trpc.storage.writeChunk.useMutation`. */
export const useStorageWriteChunk: typeof trpc.storage.writeChunk.useMutation = trpc.storage.writeChunk.useMutation

/** Generated alias around `trpc.storage.finalizeUpload.useMutation`. */
export const useStorageFinalizeUpload: typeof trpc.storage.finalizeUpload.useMutation = trpc.storage.finalizeUpload.useMutation

/** Generated alias around `trpc.storage.abortUpload.useMutation`. */
export const useStorageAbortUpload: typeof trpc.storage.abortUpload.useMutation = trpc.storage.abortUpload.useMutation

/** Generated alias around `trpc.storage.beginDownload.useMutation`. */
export const useStorageBeginDownload: typeof trpc.storage.beginDownload.useMutation = trpc.storage.beginDownload.useMutation

/** Generated alias around `trpc.storage.readChunk.useQuery`. */
export const useStorageReadChunk: typeof trpc.storage.readChunk.useQuery = trpc.storage.readChunk.useQuery

/** Generated alias around `trpc.storage.endDownload.useMutation`. */
export const useStorageEndDownload: typeof trpc.storage.endDownload.useMutation = trpc.storage.endDownload.useMutation

/** Generated alias around `trpc.storage.listLocations.useQuery`. */
export const useStorageListLocations: typeof trpc.storage.listLocations.useQuery = trpc.storage.listLocations.useQuery

/** Generated alias around `trpc.storage.listLocationDeclarations.useQuery`. */
export const useStorageListLocationDeclarations: typeof trpc.storage.listLocationDeclarations.useQuery = trpc.storage.listLocationDeclarations.useQuery

/** Generated alias around `trpc.storage.upsertLocation.useMutation`. */
export const useStorageUpsertLocation: typeof trpc.storage.upsertLocation.useMutation = trpc.storage.upsertLocation.useMutation

/** Generated alias around `trpc.storage.deleteLocation.useMutation`. */
export const useStorageDeleteLocation: typeof trpc.storage.deleteLocation.useMutation = trpc.storage.deleteLocation.useMutation

/** Generated alias around `trpc.storage.listDrainProgress.useQuery`. */
export const useStorageListDrainProgress: typeof trpc.storage.listDrainProgress.useQuery = trpc.storage.listDrainProgress.useQuery

/** Generated alias around `trpc.storage.testLocation.useQuery`. */
export const useStorageTestLocation: typeof trpc.storage.testLocation.useQuery = trpc.storage.testLocation.useQuery

/** Generated alias around `trpc.storage.listProviders.useQuery`. */
export const useStorageListProviders: typeof trpc.storage.listProviders.useQuery = trpc.storage.listProviders.useQuery

/** Generated alias around `trpc.storage.testConfig.useQuery`. */
export const useStorageTestConfig: typeof trpc.storage.testConfig.useQuery = trpc.storage.testConfig.useQuery

/** Generated alias around `trpc.storageMigration.plan.useQuery`. */
export const useStorageMigrationPlan: typeof trpc.storageMigration.plan.useQuery = trpc.storageMigration.plan.useQuery

/** Generated alias around `trpc.storageMigration.start.useMutation`. */
export const useStorageMigrationStart: typeof trpc.storageMigration.start.useMutation = trpc.storageMigration.start.useMutation

/** Generated alias around `trpc.storageMigration.status.useQuery`. */
export const useStorageMigrationStatus: typeof trpc.storageMigration.status.useQuery = trpc.storageMigration.status.useQuery

/** Generated alias around `trpc.storageMigration.cancel.useMutation`. */
export const useStorageMigrationCancel: typeof trpc.storageMigration.cancel.useMutation = trpc.storageMigration.cancel.useMutation

/** Generated alias around `trpc.storageMigration.movers.useQuery`. */
export const useStorageMigrationMovers: typeof trpc.storageMigration.movers.useQuery = trpc.storageMigration.movers.useQuery

/** Generated alias around `trpc.storageMigration.moverClearance.useQuery`. */
export const useStorageMigrationMoverClearance: typeof trpc.storageMigration.moverClearance.useQuery = trpc.storageMigration.moverClearance.useQuery

/** Generated alias around `trpc.storageMigration.residue.useQuery`. */
export const useStorageMigrationResidue: typeof trpc.storageMigration.residue.useQuery = trpc.storageMigration.residue.useQuery

/** Generated alias around `trpc.storageMigration.drain.useMutation`. */
export const useStorageMigrationDrain: typeof trpc.storageMigration.drain.useMutation = trpc.storageMigration.drain.useMutation

/** Generated alias around `trpc.storageMigration.cleanupStart.useMutation`. */
export const useStorageMigrationCleanupStart: typeof trpc.storageMigration.cleanupStart.useMutation = trpc.storageMigration.cleanupStart.useMutation

/** Generated alias around `trpc.storageMigration.cleanupStatus.useQuery`. */
export const useStorageMigrationCleanupStatus: typeof trpc.storageMigration.cleanupStatus.useQuery = trpc.storageMigration.cleanupStatus.useQuery

/** Generated alias around `trpc.storageMigration.cleanupCancel.useMutation`. */
export const useStorageMigrationCleanupCancel: typeof trpc.storageMigration.cleanupCancel.useMutation = trpc.storageMigration.cleanupCancel.useMutation

/** Generated alias around `trpc.storageMigration.history.useQuery`. */
export const useStorageMigrationHistory: typeof trpc.storageMigration.history.useQuery = trpc.storageMigration.history.useQuery

/** Generated alias around `trpc.streamBroker.reportStreamSignal.useMutation`. */
export const useStreamBrokerReportStreamSignal: typeof trpc.streamBroker.reportStreamSignal.useMutation = trpc.streamBroker.reportStreamSignal.useMutation

/** Generated alias around `trpc.streamBroker.publishCameraStream.useMutation`. */
export const useStreamBrokerPublishCameraStream: typeof trpc.streamBroker.publishCameraStream.useMutation = trpc.streamBroker.publishCameraStream.useMutation

/** Generated alias around `trpc.streamBroker.retractCameraStream.useMutation`. */
export const useStreamBrokerRetractCameraStream: typeof trpc.streamBroker.retractCameraStream.useMutation = trpc.streamBroker.retractCameraStream.useMutation

/** Generated alias around `trpc.streamBroker.assignProfile.useMutation`. */
export const useStreamBrokerAssignProfile: typeof trpc.streamBroker.assignProfile.useMutation = trpc.streamBroker.assignProfile.useMutation

/** Generated alias around `trpc.streamBroker.unassignProfile.useMutation`. */
export const useStreamBrokerUnassignProfile: typeof trpc.streamBroker.unassignProfile.useMutation = trpc.streamBroker.unassignProfile.useMutation

/** Generated alias around `trpc.streamBroker.forgetDeviceHardware.useMutation`. */
export const useStreamBrokerForgetDeviceHardware: typeof trpc.streamBroker.forgetDeviceHardware.useMutation = trpc.streamBroker.forgetDeviceHardware.useMutation

/** Generated alias around `trpc.streamBroker.renderPreBufferClip.useMutation`. */
export const useStreamBrokerRenderPreBufferClip: typeof trpc.streamBroker.renderPreBufferClip.useMutation = trpc.streamBroker.renderPreBufferClip.useMutation

/** Generated alias around `trpc.streamBroker.produceEventMedia.useMutation`. */
export const useStreamBrokerProduceEventMedia: typeof trpc.streamBroker.produceEventMedia.useMutation = trpc.streamBroker.produceEventMedia.useMutation

/** Generated alias around `trpc.streamBroker.fetchEventMedia.useMutation`. */
export const useStreamBrokerFetchEventMedia: typeof trpc.streamBroker.fetchEventMedia.useMutation = trpc.streamBroker.fetchEventMedia.useMutation

/** Generated alias around `trpc.streamBroker.listAllCameraStreams.useQuery`. */
export const useStreamBrokerListAllCameraStreams: typeof trpc.streamBroker.listAllCameraStreams.useQuery = trpc.streamBroker.listAllCameraStreams.useQuery

/** Generated alias around `trpc.streamBroker.listAllProfileSlots.useQuery`. */
export const useStreamBrokerListAllProfileSlots: typeof trpc.streamBroker.listAllProfileSlots.useQuery = trpc.streamBroker.listAllProfileSlots.useQuery

/** Generated alias around `trpc.streamBroker.getBrokerStats.useQuery`. */
export const useStreamBrokerGetBrokerStats: typeof trpc.streamBroker.getBrokerStats.useQuery = trpc.streamBroker.getBrokerStats.useQuery

/** Generated alias around `trpc.streamBroker.probeStream.useMutation`. */
export const useStreamBrokerProbeStream: typeof trpc.streamBroker.probeStream.useMutation = trpc.streamBroker.probeStream.useMutation

/** Generated alias around `trpc.streamBroker.listClients.useQuery`. */
export const useStreamBrokerListClients: typeof trpc.streamBroker.listClients.useQuery = trpc.streamBroker.listClients.useQuery

/** Generated alias around `trpc.streamBroker.getLiveViewerCounts.useQuery`. */
export const useStreamBrokerGetLiveViewerCounts: typeof trpc.streamBroker.getLiveViewerCounts.useQuery = trpc.streamBroker.getLiveViewerCounts.useQuery

/** Generated alias around `trpc.streamBroker.killClient.useMutation`. */
export const useStreamBrokerKillClient: typeof trpc.streamBroker.killClient.useMutation = trpc.streamBroker.killClient.useMutation

/** Generated alias around `trpc.streamBroker.restartProfile.useMutation`. */
export const useStreamBrokerRestartProfile: typeof trpc.streamBroker.restartProfile.useMutation = trpc.streamBroker.restartProfile.useMutation

/** Generated alias around `trpc.streamBroker.getStreamUrl.useQuery`. */
export const useStreamBrokerGetStreamUrl: typeof trpc.streamBroker.getStreamUrl.useQuery = trpc.streamBroker.getStreamUrl.useQuery

/** Generated alias around `trpc.streamBroker.getStreamWithCodec.useMutation`. */
export const useStreamBrokerGetStreamWithCodec: typeof trpc.streamBroker.getStreamWithCodec.useMutation = trpc.streamBroker.getStreamWithCodec.useMutation

/** Generated alias around `trpc.streamBroker.releaseStreamWithCodec.useMutation`. */
export const useStreamBrokerReleaseStreamWithCodec: typeof trpc.streamBroker.releaseStreamWithCodec.useMutation = trpc.streamBroker.releaseStreamWithCodec.useMutation

/** Generated alias around `trpc.streamBroker.acquireEgressTranscode.useMutation`. */
export const useStreamBrokerAcquireEgressTranscode: typeof trpc.streamBroker.acquireEgressTranscode.useMutation = trpc.streamBroker.acquireEgressTranscode.useMutation

/** Generated alias around `trpc.streamBroker.releaseEgressTranscode.useMutation`. */
export const useStreamBrokerReleaseEgressTranscode: typeof trpc.streamBroker.releaseEgressTranscode.useMutation = trpc.streamBroker.releaseEgressTranscode.useMutation

/** Generated alias around `trpc.streamBroker.subscribeAudioChunks.useMutation`. */
export const useStreamBrokerSubscribeAudioChunks: typeof trpc.streamBroker.subscribeAudioChunks.useMutation = trpc.streamBroker.subscribeAudioChunks.useMutation

/** Generated alias around `trpc.streamBroker.pullAudioChunks.useQuery`. */
export const useStreamBrokerPullAudioChunks: typeof trpc.streamBroker.pullAudioChunks.useQuery = trpc.streamBroker.pullAudioChunks.useQuery

/** Generated alias around `trpc.streamBroker.unsubscribeAudioChunks.useMutation`. */
export const useStreamBrokerUnsubscribeAudioChunks: typeof trpc.streamBroker.unsubscribeAudioChunks.useMutation = trpc.streamBroker.unsubscribeAudioChunks.useMutation

/** Generated alias around `trpc.streamBroker.setPreBufferDuration.useMutation`. */
export const useStreamBrokerSetPreBufferDuration: typeof trpc.streamBroker.setPreBufferDuration.useMutation = trpc.streamBroker.setPreBufferDuration.useMutation

/** Generated alias around `trpc.streamBroker.getPreBufferInfo.useQuery`. */
export const useStreamBrokerGetPreBufferInfo: typeof trpc.streamBroker.getPreBufferInfo.useQuery = trpc.streamBroker.getPreBufferInfo.useQuery

/** Generated alias around `trpc.streamBroker.getRtspPort.useQuery`. */
export const useStreamBrokerGetRtspPort: typeof trpc.streamBroker.getRtspPort.useQuery = trpc.streamBroker.getRtspPort.useQuery

/** Generated alias around `trpc.streamBroker.getAllRtspEntries.useQuery`. */
export const useStreamBrokerGetAllRtspEntries: typeof trpc.streamBroker.getAllRtspEntries.useQuery = trpc.streamBroker.getAllRtspEntries.useQuery

/** Generated alias around `trpc.streamBroker.getRtspEntry.useQuery`. */
export const useStreamBrokerGetRtspEntry: typeof trpc.streamBroker.getRtspEntry.useQuery = trpc.streamBroker.getRtspEntry.useQuery

/** Generated alias around `trpc.streamBroker.regenerateRtspToken.useMutation`. */
export const useStreamBrokerRegenerateRtspToken: typeof trpc.streamBroker.regenerateRtspToken.useMutation = trpc.streamBroker.regenerateRtspToken.useMutation

/** Generated alias around `trpc.streamBroker.setRtspEnabled.useMutation`. */
export const useStreamBrokerSetRtspEnabled: typeof trpc.streamBroker.setRtspEnabled.useMutation = trpc.streamBroker.setRtspEnabled.useMutation

/** Generated alias around `trpc.streamBroker.isRtspEnabled.useQuery`. */
export const useStreamBrokerIsRtspEnabled: typeof trpc.streamBroker.isRtspEnabled.useQuery = trpc.streamBroker.isRtspEnabled.useQuery

/** Generated alias around `trpc.streamBroker.getDeviceAudioMute.useQuery`. */
export const useStreamBrokerGetDeviceAudioMute: typeof trpc.streamBroker.getDeviceAudioMute.useQuery = trpc.streamBroker.getDeviceAudioMute.useQuery

/** Generated alias around `trpc.streamBroker.setDeviceAudioMute.useMutation`. */
export const useStreamBrokerSetDeviceAudioMute: typeof trpc.streamBroker.setDeviceAudioMute.useMutation = trpc.streamBroker.setDeviceAudioMute.useMutation

/** Generated alias around `trpc.streamBroker.getDeviceSettingsContribution.useQuery`. */
export const useStreamBrokerGetDeviceSettingsContribution: typeof trpc.streamBroker.getDeviceSettingsContribution.useQuery = trpc.streamBroker.getDeviceSettingsContribution.useQuery

/** Generated alias around `trpc.streamBroker.getDeviceLiveContribution.useQuery`. */
export const useStreamBrokerGetDeviceLiveContribution: typeof trpc.streamBroker.getDeviceLiveContribution.useQuery = trpc.streamBroker.getDeviceLiveContribution.useQuery

/** Generated alias around `trpc.streamBroker.applyDeviceSettingsPatch.useMutation`. */
export const useStreamBrokerApplyDeviceSettingsPatch: typeof trpc.streamBroker.applyDeviceSettingsPatch.useMutation = trpc.streamBroker.applyDeviceSettingsPatch.useMutation

/** Generated alias around `trpc.streamCatalog.getCatalog.useQuery`. */
export const useStreamCatalogGetCatalog: typeof trpc.streamCatalog.getCatalog.useQuery = trpc.streamCatalog.getCatalog.useQuery

/** Generated alias around `trpc.streamParams.getOptions.useQuery`. */
export const useStreamParamsGetOptions: typeof trpc.streamParams.getOptions.useQuery = trpc.streamParams.getOptions.useQuery

/** Generated alias around `trpc.streamParams.setProfile.useMutation`. */
export const useStreamParamsSetProfile: typeof trpc.streamParams.setProfile.useMutation = trpc.streamParams.setProfile.useMutation

/** Generated alias around `trpc.streamParams.getConfigSchema.useQuery`. */
export const useStreamParamsGetConfigSchema: typeof trpc.streamParams.getConfigSchema.useQuery = trpc.streamParams.getConfigSchema.useQuery

/** Generated alias around `trpc.streamParams.getStatus.useQuery`. */
export const useStreamParamsGetStatus: typeof trpc.streamParams.getStatus.useQuery = trpc.streamParams.getStatus.useQuery

/** Generated alias around `trpc.streamSignals.listSignals.useQuery`. */
export const useStreamSignalsListSignals: typeof trpc.streamSignals.listSignals.useQuery = trpc.streamSignals.listSignals.useQuery

/** Generated alias around `trpc.switch.setState.useMutation`. */
export const useSwitchSetState: typeof trpc.switch.setState.useMutation = trpc.switch.setState.useMutation

/** Generated alias around `trpc.switch.getStatus.useQuery`. */
export const useSwitchGetStatus: typeof trpc.switch.getStatus.useQuery = trpc.switch.getStatus.useQuery

/** Generated alias around `trpc.system.info.useQuery`. */
export const useSystemInfo: typeof trpc.system.info.useQuery = trpc.system.info.useQuery

/** Generated alias around `trpc.system.health.useQuery`. */
export const useSystemHealth: typeof trpc.system.health.useQuery = trpc.system.health.useQuery

/** Generated alias around `trpc.system.featureFlags.useQuery`. */
export const useSystemFeatureFlags: typeof trpc.system.featureFlags.useQuery = trpc.system.featureFlags.useQuery

/** Generated alias around `trpc.system.networkAddresses.useQuery`. */
export const useSystemNetworkAddresses: typeof trpc.system.networkAddresses.useQuery = trpc.system.networkAddresses.useQuery

/** Generated alias around `trpc.system.getRetentionConfig.useQuery`. */
export const useSystemGetRetentionConfig: typeof trpc.system.getRetentionConfig.useQuery = trpc.system.getRetentionConfig.useQuery

/** Generated alias around `trpc.system.setRetentionConfig.useMutation`. */
export const useSystemSetRetentionConfig: typeof trpc.system.setRetentionConfig.useMutation = trpc.system.setRetentionConfig.useMutation

/** Generated alias around `trpc.system.forceRetentionCleanup.useMutation`. */
export const useSystemForceRetentionCleanup: typeof trpc.system.forceRetentionCleanup.useMutation = trpc.system.forceRetentionCleanup.useMutation

/** Generated alias around `trpc.system.getSiteLocation.useQuery`. */
export const useSystemGetSiteLocation: typeof trpc.system.getSiteLocation.useQuery = trpc.system.getSiteLocation.useQuery

/** Generated alias around `trpc.system.setSiteLocation.useMutation`. */
export const useSystemSetSiteLocation: typeof trpc.system.setSiteLocation.useMutation = trpc.system.setSiteLocation.useMutation

/** Generated alias around `trpc.system.detectSiteLocation.useMutation`. */
export const useSystemDetectSiteLocation: typeof trpc.system.detectSiteLocation.useMutation = trpc.system.detectSiteLocation.useMutation

/** Generated alias around `trpc.system.getRequestCensus.useQuery`. */
export const useSystemGetRequestCensus: typeof trpc.system.getRequestCensus.useQuery = trpc.system.getRequestCensus.useQuery

/** Generated alias around `trpc.system.getLoadContributions.useQuery`. */
export const useSystemGetLoadContributions: typeof trpc.system.getLoadContributions.useQuery = trpc.system.getLoadContributions.useQuery

/** Generated alias around `trpc.system.getFailureContributions.useQuery`. */
export const useSystemGetFailureContributions: typeof trpc.system.getFailureContributions.useQuery = trpc.system.getFailureContributions.useQuery

/** Generated alias around `trpc.system.getLoggingSettings.useQuery`. */
export const useSystemGetLoggingSettings: typeof trpc.system.getLoggingSettings.useQuery = trpc.system.getLoggingSettings.useQuery

/** Generated alias around `trpc.system.setLoggingSettings.useMutation`. */
export const useSystemSetLoggingSettings: typeof trpc.system.setLoggingSettings.useMutation = trpc.system.setLoggingSettings.useMutation

/** Generated alias around `trpc.tamper.getStatus.useQuery`. */
export const useTamperGetStatus: typeof trpc.tamper.getStatus.useQuery = trpc.tamper.getStatus.useQuery

/** Generated alias around `trpc.temperatureSensor.getStatus.useQuery`. */
export const useTemperatureSensorGetStatus: typeof trpc.temperatureSensor.getStatus.useQuery = trpc.temperatureSensor.getStatus.useQuery

/** Generated alias around `trpc.terminalSession.listProfiles.useQuery`. */
export const useTerminalSessionListProfiles: typeof trpc.terminalSession.listProfiles.useQuery = trpc.terminalSession.listProfiles.useQuery

/** Generated alias around `trpc.terminalSession.listInstances.useQuery`. */
export const useTerminalSessionListInstances: typeof trpc.terminalSession.listInstances.useQuery = trpc.terminalSession.listInstances.useQuery

/** Generated alias around `trpc.terminalSession.createInstance.useMutation`. */
export const useTerminalSessionCreateInstance: typeof trpc.terminalSession.createInstance.useMutation = trpc.terminalSession.createInstance.useMutation

/** Generated alias around `trpc.terminalSession.updateInstance.useMutation`. */
export const useTerminalSessionUpdateInstance: typeof trpc.terminalSession.updateInstance.useMutation = trpc.terminalSession.updateInstance.useMutation

/** Generated alias around `trpc.terminalSession.deleteInstance.useMutation`. */
export const useTerminalSessionDeleteInstance: typeof trpc.terminalSession.deleteInstance.useMutation = trpc.terminalSession.deleteInstance.useMutation

/** Generated alias around `trpc.terminalSession.setInstanceEnabled.useMutation`. */
export const useTerminalSessionSetInstanceEnabled: typeof trpc.terminalSession.setInstanceEnabled.useMutation = trpc.terminalSession.setInstanceEnabled.useMutation

/** Generated alias around `trpc.terminalSession.listLegacyCameras.useQuery`. */
export const useTerminalSessionListLegacyCameras: typeof trpc.terminalSession.listLegacyCameras.useQuery = trpc.terminalSession.listLegacyCameras.useQuery

/** Generated alias around `trpc.terminalSession.adoptLegacyMonitor.useMutation`. */
export const useTerminalSessionAdoptLegacyMonitor: typeof trpc.terminalSession.adoptLegacyMonitor.useMutation = trpc.terminalSession.adoptLegacyMonitor.useMutation

/** Generated alias around `trpc.terminalSession.listSessions.useQuery`. */
export const useTerminalSessionListSessions: typeof trpc.terminalSession.listSessions.useQuery = trpc.terminalSession.listSessions.useQuery

/** Generated alias around `trpc.terminalSession.openSession.useMutation`. */
export const useTerminalSessionOpenSession: typeof trpc.terminalSession.openSession.useMutation = trpc.terminalSession.openSession.useMutation

/** Generated alias around `trpc.terminalSession.resize.useMutation`. */
export const useTerminalSessionResize: typeof trpc.terminalSession.resize.useMutation = trpc.terminalSession.resize.useMutation

/** Generated alias around `trpc.terminalSession.pullOutput.useMutation`. */
export const useTerminalSessionPullOutput: typeof trpc.terminalSession.pullOutput.useMutation = trpc.terminalSession.pullOutput.useMutation

/** Generated alias around `trpc.terminalSession.writeInput.useMutation`. */
export const useTerminalSessionWriteInput: typeof trpc.terminalSession.writeInput.useMutation = trpc.terminalSession.writeInput.useMutation

/** Generated alias around `trpc.terminalSession.close.useMutation`. */
export const useTerminalSessionClose: typeof trpc.terminalSession.close.useMutation = trpc.terminalSession.close.useMutation

/** Generated alias around `trpc.toast.onToast.useSubscription`. */
export const useToastOnToast: typeof trpc.toast.onToast.useSubscription = trpc.toast.onToast.useSubscription

/** Generated alias around `trpc.training.listBaseModels.useQuery`. */
export const useTrainingListBaseModels: typeof trpc.training.listBaseModels.useQuery = trpc.training.listBaseModels.useQuery

/** Generated alias around `trpc.training.planJob.useQuery`. */
export const useTrainingPlanJob: typeof trpc.training.planJob.useQuery = trpc.training.planJob.useQuery

/** Generated alias around `trpc.training.startJob.useMutation`. */
export const useTrainingStartJob: typeof trpc.training.startJob.useMutation = trpc.training.startJob.useMutation

/** Generated alias around `trpc.training.startJobBatch.useMutation`. */
export const useTrainingStartJobBatch: typeof trpc.training.startJobBatch.useMutation = trpc.training.startJobBatch.useMutation

/** Generated alias around `trpc.training.listJobs.useQuery`. */
export const useTrainingListJobs: typeof trpc.training.listJobs.useQuery = trpc.training.listJobs.useQuery

/** Generated alias around `trpc.training.getJob.useQuery`. */
export const useTrainingGetJob: typeof trpc.training.getJob.useQuery = trpc.training.getJob.useQuery

/** Generated alias around `trpc.training.cancelJob.useMutation`. */
export const useTrainingCancelJob: typeof trpc.training.cancelJob.useMutation = trpc.training.cancelJob.useMutation

/** Generated alias around `trpc.training.getJobResult.useQuery`. */
export const useTrainingGetJobResult: typeof trpc.training.getJobResult.useQuery = trpc.training.getJobResult.useQuery

/** Generated alias around `trpc.training.listCanaryTargets.useQuery`. */
export const useTrainingListCanaryTargets: typeof trpc.training.listCanaryTargets.useQuery = trpc.training.listCanaryTargets.useQuery

/** Generated alias around `trpc.training.registerResult.useMutation`. */
export const useTrainingRegisterResult: typeof trpc.training.registerResult.useMutation = trpc.training.registerResult.useMutation

/** Generated alias around `trpc.training.canaryResult.useMutation`. */
export const useTrainingCanaryResult: typeof trpc.training.canaryResult.useMutation = trpc.training.canaryResult.useMutation

/** Generated alias around `trpc.training.rollbackCanary.useMutation`. */
export const useTrainingRollbackCanary: typeof trpc.training.rollbackCanary.useMutation = trpc.training.rollbackCanary.useMutation

/** Generated alias around `trpc.training.discardResult.useMutation`. */
export const useTrainingDiscardResult: typeof trpc.training.discardResult.useMutation = trpc.training.discardResult.useMutation

/** Generated alias around `trpc.turnProvider.getTurnServers.useQuery`. */
export const useTurnProviderGetTurnServers: typeof trpc.turnProvider.getTurnServers.useQuery = trpc.turnProvider.getTurnServers.useQuery

/** Generated alias around `trpc.update.installUpdate.useMutation`. */
export const useUpdateInstallUpdate: typeof trpc.update.installUpdate.useMutation = trpc.update.installUpdate.useMutation

/** Generated alias around `trpc.update.getStatus.useQuery`. */
export const useUpdateGetStatus: typeof trpc.update.getStatus.useQuery = trpc.update.getStatus.useQuery

/** Generated alias around `trpc.userManagement.listUsers.useQuery`. */
export const useUserManagementListUsers: typeof trpc.userManagement.listUsers.useQuery = trpc.userManagement.listUsers.useQuery

/** Generated alias around `trpc.userManagement.createUser.useMutation`. */
export const useUserManagementCreateUser: typeof trpc.userManagement.createUser.useMutation = trpc.userManagement.createUser.useMutation

/** Generated alias around `trpc.userManagement.updateUser.useMutation`. */
export const useUserManagementUpdateUser: typeof trpc.userManagement.updateUser.useMutation = trpc.userManagement.updateUser.useMutation

/** Generated alias around `trpc.userManagement.deleteUser.useMutation`. */
export const useUserManagementDeleteUser: typeof trpc.userManagement.deleteUser.useMutation = trpc.userManagement.deleteUser.useMutation

/** Generated alias around `trpc.userManagement.resetPassword.useMutation`. */
export const useUserManagementResetPassword: typeof trpc.userManagement.resetPassword.useMutation = trpc.userManagement.resetPassword.useMutation

/** Generated alias around `trpc.userManagement.setUserScopes.useMutation`. */
export const useUserManagementSetUserScopes: typeof trpc.userManagement.setUserScopes.useMutation = trpc.userManagement.setUserScopes.useMutation

/** Generated alias around `trpc.userManagement.validateCredentials.useMutation`. */
export const useUserManagementValidateCredentials: typeof trpc.userManagement.validateCredentials.useMutation = trpc.userManagement.validateCredentials.useMutation

/** Generated alias around `trpc.userManagement.setupTotp.useMutation`. */
export const useUserManagementSetupTotp: typeof trpc.userManagement.setupTotp.useMutation = trpc.userManagement.setupTotp.useMutation

/** Generated alias around `trpc.userManagement.confirmTotp.useMutation`. */
export const useUserManagementConfirmTotp: typeof trpc.userManagement.confirmTotp.useMutation = trpc.userManagement.confirmTotp.useMutation

/** Generated alias around `trpc.userManagement.disableTotp.useMutation`. */
export const useUserManagementDisableTotp: typeof trpc.userManagement.disableTotp.useMutation = trpc.userManagement.disableTotp.useMutation

/** Generated alias around `trpc.userManagement.getTotpStatus.useQuery`. */
export const useUserManagementGetTotpStatus: typeof trpc.userManagement.getTotpStatus.useQuery = trpc.userManagement.getTotpStatus.useQuery

/** Generated alias around `trpc.userManagement.migrateRawSecrets.useMutation`. */
export const useUserManagementMigrateRawSecrets: typeof trpc.userManagement.migrateRawSecrets.useMutation = trpc.userManagement.migrateRawSecrets.useMutation

/** Generated alias around `trpc.userManagement.verifyTotp.useMutation`. */
export const useUserManagementVerifyTotp: typeof trpc.userManagement.verifyTotp.useMutation = trpc.userManagement.verifyTotp.useMutation

/** Generated alias around `trpc.userManagement.oauthIssueCode.useMutation`. */
export const useUserManagementOauthIssueCode: typeof trpc.userManagement.oauthIssueCode.useMutation = trpc.userManagement.oauthIssueCode.useMutation

/** Generated alias around `trpc.userManagement.oauthExchangeCode.useMutation`. */
export const useUserManagementOauthExchangeCode: typeof trpc.userManagement.oauthExchangeCode.useMutation = trpc.userManagement.oauthExchangeCode.useMutation

/** Generated alias around `trpc.userManagement.oauthRefresh.useMutation`. */
export const useUserManagementOauthRefresh: typeof trpc.userManagement.oauthRefresh.useMutation = trpc.userManagement.oauthRefresh.useMutation

/** Generated alias around `trpc.userManagement.oauthVerifyAccessToken.useQuery`. */
export const useUserManagementOauthVerifyAccessToken: typeof trpc.userManagement.oauthVerifyAccessToken.useQuery = trpc.userManagement.oauthVerifyAccessToken.useQuery

/** Generated alias around `trpc.userManagement.listExternalIdentities.useQuery`. */
export const useUserManagementListExternalIdentities: typeof trpc.userManagement.listExternalIdentities.useQuery = trpc.userManagement.listExternalIdentities.useQuery

/** Generated alias around `trpc.userManagement.findUserByExternalIdentity.useQuery`. */
export const useUserManagementFindUserByExternalIdentity: typeof trpc.userManagement.findUserByExternalIdentity.useQuery = trpc.userManagement.findUserByExternalIdentity.useQuery

/** Generated alias around `trpc.userManagement.unlinkExternalIdentity.useMutation`. */
export const useUserManagementUnlinkExternalIdentity: typeof trpc.userManagement.unlinkExternalIdentity.useMutation = trpc.userManagement.unlinkExternalIdentity.useMutation

/** Generated alias around `trpc.userManagement.listOauthSessions.useQuery`. */
export const useUserManagementListOauthSessions: typeof trpc.userManagement.listOauthSessions.useQuery = trpc.userManagement.listOauthSessions.useQuery

/** Generated alias around `trpc.userManagement.revokeOauthSession.useMutation`. */
export const useUserManagementRevokeOauthSession: typeof trpc.userManagement.revokeOauthSession.useMutation = trpc.userManagement.revokeOauthSession.useMutation

/** Generated alias around `trpc.vacuumControl.start.useMutation`. */
export const useVacuumControlStart: typeof trpc.vacuumControl.start.useMutation = trpc.vacuumControl.start.useMutation

/** Generated alias around `trpc.vacuumControl.pause.useMutation`. */
export const useVacuumControlPause: typeof trpc.vacuumControl.pause.useMutation = trpc.vacuumControl.pause.useMutation

/** Generated alias around `trpc.vacuumControl.stop.useMutation`. */
export const useVacuumControlStop: typeof trpc.vacuumControl.stop.useMutation = trpc.vacuumControl.stop.useMutation

/** Generated alias around `trpc.vacuumControl.returnToBase.useMutation`. */
export const useVacuumControlReturnToBase: typeof trpc.vacuumControl.returnToBase.useMutation = trpc.vacuumControl.returnToBase.useMutation

/** Generated alias around `trpc.vacuumControl.locate.useMutation`. */
export const useVacuumControlLocate: typeof trpc.vacuumControl.locate.useMutation = trpc.vacuumControl.locate.useMutation

/** Generated alias around `trpc.vacuumControl.setFanSpeed.useMutation`. */
export const useVacuumControlSetFanSpeed: typeof trpc.vacuumControl.setFanSpeed.useMutation = trpc.vacuumControl.setFanSpeed.useMutation

/** Generated alias around `trpc.vacuumControl.getStatus.useQuery`. */
export const useVacuumControlGetStatus: typeof trpc.vacuumControl.getStatus.useQuery = trpc.vacuumControl.getStatus.useQuery

/** Generated alias around `trpc.valve.open.useMutation`. */
export const useValveOpen: typeof trpc.valve.open.useMutation = trpc.valve.open.useMutation

/** Generated alias around `trpc.valve.close.useMutation`. */
export const useValveClose: typeof trpc.valve.close.useMutation = trpc.valve.close.useMutation

/** Generated alias around `trpc.valve.stop.useMutation`. */
export const useValveStop: typeof trpc.valve.stop.useMutation = trpc.valve.stop.useMutation

/** Generated alias around `trpc.valve.setPosition.useMutation`. */
export const useValveSetPosition: typeof trpc.valve.setPosition.useMutation = trpc.valve.setPosition.useMutation

/** Generated alias around `trpc.valve.getStatus.useQuery`. */
export const useValveGetStatus: typeof trpc.valve.getStatus.useQuery = trpc.valve.getStatus.useQuery

/** Generated alias around `trpc.vibration.getStatus.useQuery`. */
export const useVibrationGetStatus: typeof trpc.vibration.getStatus.useQuery = trpc.vibration.getStatus.useQuery

/** Generated alias around `trpc.videoclips.listClips.useQuery`. */
export const useVideoclipsListClips: typeof trpc.videoclips.listClips.useQuery = trpc.videoclips.listClips.useQuery

/** Generated alias around `trpc.videoclips.listSources.useQuery`. */
export const useVideoclipsListSources: typeof trpc.videoclips.listSources.useQuery = trpc.videoclips.listSources.useQuery

/** Generated alias around `trpc.videoclips.getClipPlayback.useQuery`. */
export const useVideoclipsGetClipPlayback: typeof trpc.videoclips.getClipPlayback.useQuery = trpc.videoclips.getClipPlayback.useQuery

/** Generated alias around `trpc.videoclips.readClipBytes.useQuery`. */
export const useVideoclipsReadClipBytes: typeof trpc.videoclips.readClipBytes.useQuery = trpc.videoclips.readClipBytes.useQuery

/** Generated alias around `trpc.videoclips.offerClipBytes.useQuery`. */
export const useVideoclipsOfferClipBytes: typeof trpc.videoclips.offerClipBytes.useQuery = trpc.videoclips.offerClipBytes.useQuery

/** Generated alias around `trpc.videoclips.dialClipStream.useQuery`. */
export const useVideoclipsDialClipStream: typeof trpc.videoclips.dialClipStream.useQuery = trpc.videoclips.dialClipStream.useQuery

/** Generated alias around `trpc.videoclips.getPlaybackOptions.useQuery`. */
export const useVideoclipsGetPlaybackOptions: typeof trpc.videoclips.getPlaybackOptions.useQuery = trpc.videoclips.getPlaybackOptions.useQuery

/** Generated alias around `trpc.waterHeater.setTargetTemp.useMutation`. */
export const useWaterHeaterSetTargetTemp: typeof trpc.waterHeater.setTargetTemp.useMutation = trpc.waterHeater.setTargetTemp.useMutation

/** Generated alias around `trpc.waterHeater.setOperationMode.useMutation`. */
export const useWaterHeaterSetOperationMode: typeof trpc.waterHeater.setOperationMode.useMutation = trpc.waterHeater.setOperationMode.useMutation

/** Generated alias around `trpc.waterHeater.setAway.useMutation`. */
export const useWaterHeaterSetAway: typeof trpc.waterHeater.setAway.useMutation = trpc.waterHeater.setAway.useMutation

/** Generated alias around `trpc.waterHeater.getStatus.useQuery`. */
export const useWaterHeaterGetStatus: typeof trpc.waterHeater.getStatus.useQuery = trpc.waterHeater.getStatus.useQuery

/** Generated alias around `trpc.weather.getStatus.useQuery`. */
export const useWeatherGetStatus: typeof trpc.weather.getStatus.useQuery = trpc.weather.getStatus.useQuery

/** Generated alias around `trpc.webrtcSession.listStreams.useQuery`. */
export const useWebrtcSessionListStreams: typeof trpc.webrtcSession.listStreams.useQuery = trpc.webrtcSession.listStreams.useQuery

/** Generated alias around `trpc.webrtcSession.createSession.useMutation`. */
export const useWebrtcSessionCreateSession: typeof trpc.webrtcSession.createSession.useMutation = trpc.webrtcSession.createSession.useMutation

/** Generated alias around `trpc.webrtcSession.handleOffer.useMutation`. */
export const useWebrtcSessionHandleOffer: typeof trpc.webrtcSession.handleOffer.useMutation = trpc.webrtcSession.handleOffer.useMutation

/** Generated alias around `trpc.webrtcSession.handleAnswer.useMutation`. */
export const useWebrtcSessionHandleAnswer: typeof trpc.webrtcSession.handleAnswer.useMutation = trpc.webrtcSession.handleAnswer.useMutation

/** Generated alias around `trpc.webrtcSession.addIceCandidate.useMutation`. */
export const useWebrtcSessionAddIceCandidate: typeof trpc.webrtcSession.addIceCandidate.useMutation = trpc.webrtcSession.addIceCandidate.useMutation

/** Generated alias around `trpc.webrtcSession.getIceCandidates.useQuery`. */
export const useWebrtcSessionGetIceCandidates: typeof trpc.webrtcSession.getIceCandidates.useQuery = trpc.webrtcSession.getIceCandidates.useQuery

/** Generated alias around `trpc.webrtcSession.closeSession.useMutation`. */
export const useWebrtcSessionCloseSession: typeof trpc.webrtcSession.closeSession.useMutation = trpc.webrtcSession.closeSession.useMutation

/** Generated alias around `trpc.webrtcSession.hasAdaptiveBitrate.useQuery`. */
export const useWebrtcSessionHasAdaptiveBitrate: typeof trpc.webrtcSession.hasAdaptiveBitrate.useQuery = trpc.webrtcSession.hasAdaptiveBitrate.useQuery

/** Generated alias around `trpc.webrtcSession.getSessionState.useQuery`. */
export const useWebrtcSessionGetSessionState: typeof trpc.webrtcSession.getSessionState.useQuery = trpc.webrtcSession.getSessionState.useQuery

/** Generated alias around `trpc.webrtcSession.applyDownlinkProbe.useMutation`. */
export const useWebrtcSessionApplyDownlinkProbe: typeof trpc.webrtcSession.applyDownlinkProbe.useMutation = trpc.webrtcSession.applyDownlinkProbe.useMutation

/** Generated alias around `trpc.webrtcSession.getSessionDebug.useQuery`. */
export const useWebrtcSessionGetSessionDebug: typeof trpc.webrtcSession.getSessionDebug.useQuery = trpc.webrtcSession.getSessionDebug.useQuery

/** Generated alias around `trpc.zoneAnalytics.getCurrentSnapshot.useQuery`. */
export const useZoneAnalyticsGetCurrentSnapshot: typeof trpc.zoneAnalytics.getCurrentSnapshot.useQuery = trpc.zoneAnalytics.getCurrentSnapshot.useQuery

/** Generated alias around `trpc.zoneAnalytics.getCurrentSnapshotBatch.useQuery`. */
export const useZoneAnalyticsGetCurrentSnapshotBatch: typeof trpc.zoneAnalytics.getCurrentSnapshotBatch.useQuery = trpc.zoneAnalytics.getCurrentSnapshotBatch.useQuery

/** Generated alias around `trpc.zoneAnalytics.getZoneHistory.useQuery`. */
export const useZoneAnalyticsGetZoneHistory: typeof trpc.zoneAnalytics.getZoneHistory.useQuery = trpc.zoneAnalytics.getZoneHistory.useQuery

/** Generated alias around `trpc.zoneAnalytics.getCameraHistory.useQuery`. */
export const useZoneAnalyticsGetCameraHistory: typeof trpc.zoneAnalytics.getCameraHistory.useQuery = trpc.zoneAnalytics.getCameraHistory.useQuery

/** Generated alias around `trpc.zoneAnalytics.getUnzonedHistory.useQuery`. */
export const useZoneAnalyticsGetUnzonedHistory: typeof trpc.zoneAnalytics.getUnzonedHistory.useQuery = trpc.zoneAnalytics.getUnzonedHistory.useQuery

/** Generated alias around `trpc.zoneRules.listRules.useQuery`. */
export const useZoneRulesListRules: typeof trpc.zoneRules.listRules.useQuery = trpc.zoneRules.listRules.useQuery

/** Generated alias around `trpc.zoneRules.setRules.useMutation`. */
export const useZoneRulesSetRules: typeof trpc.zoneRules.setRules.useMutation = trpc.zoneRules.setRules.useMutation

/** Generated alias around `trpc.zones.listZones.useQuery`. */
export const useZonesListZones: typeof trpc.zones.listZones.useQuery = trpc.zones.listZones.useQuery

/** Generated alias around `trpc.zones.addZone.useMutation`. */
export const useZonesAddZone: typeof trpc.zones.addZone.useMutation = trpc.zones.addZone.useMutation

/** Generated alias around `trpc.zones.removeZone.useMutation`. */
export const useZonesRemoveZone: typeof trpc.zones.removeZone.useMutation = trpc.zones.removeZone.useMutation

/** Generated alias around `trpc.zones.updateZone.useMutation`. */
export const useZonesUpdateZone: typeof trpc.zones.updateZone.useMutation = trpc.zones.updateZone.useMutation
