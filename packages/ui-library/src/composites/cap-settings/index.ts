export { AutotrackSection } from './AutotrackSection'
export { ConsumablesPanel } from './ConsumablesPanel'
export type { MaskShapeCanvasProps, MaskShapeItem } from './MaskShapeCanvas'
export { MaskShapeCanvas } from './MaskShapeCanvas'
export { MotionZonesSettings } from './MotionZonesSettings'
export { PrivacyMaskSettings } from './PrivacyMaskSettings'
export { NavigationPanel } from './NavigationPanel'
export { PtzPanel } from './PtzPanel'
export { RecordingBandsEditor } from './RecordingBandsEditor'
export { RecordingPanel } from './RecordingPanel'
export { RecordingSettings } from './RecordingSettings'
export { SceneMonitorEditor } from './SceneMonitorEditor'

/**
 * Props every cap-settings component receives.
 *
 * Components are resolved by `componentId` through the admin-ui
 * `UI_COMPONENTS` registry (the cap-name-keyed `CAP_SETTINGS_COMPONENTS`
 * registry has been retired). This shape mirrors the admin-ui
 * `UiComponentProps` contract.
 */
export interface CapSettingsComponentProps {
  readonly deviceId: number
}
