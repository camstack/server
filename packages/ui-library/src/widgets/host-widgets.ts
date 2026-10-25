import { type ComponentType, lazy } from 'react'
import { AutotrackSection } from '../composites/cap-settings/AutotrackSection.js'
import { CameraGridLayoutEditor } from '../composites/cap-settings/CameraGridLayoutEditor.js'
import { ConsumablesPanel } from '../composites/cap-settings/ConsumablesPanel.js'
// Import non-konva widgets directly (NOT from the barrel) — the barrel
// re-exports MaskShapeCanvas/MotionZonesSettings/PrivacyMaskSettings and
// would chain statically back to react-konva.
import { ClipsSection } from '../composites/clips/ClipsSection.js'
import { ExtensionsPanel } from '../composites/extensions/ExtensionsPanel.js'
import { NavigationPanel } from '../composites/cap-settings/NavigationPanel.js'
import { PtzPanel } from '../composites/cap-settings/PtzPanel.js'
import { RecordingPanel } from '../composites/cap-settings/RecordingPanel.js'

/** Props every host (in-bundle) widget receives. */
export interface HostWidgetProps {
  readonly deviceId: number
}

// MotionZonesSettings and PrivacyMaskSettings import react-konva / konva
// (via MaskShapeCanvas).  Deferring them as React.lazy components keeps konva
// OFF the host's synchronous import graph, so the ~300 KB konva bundle is NOT
// included in first-paint chunks.  The MF singleton guarantee is preserved:
// `singleton:true,requiredVersion:false` in vite.config.ts ensures that once
// any bundle (host or remote) loads konva, every other bundle shares that
// single instance through the MF runtime sharing layer.
//
// WidgetSlot wraps host-widget rendering in a <Suspense> fallback (the same
// WidgetSkeleton used for remote widgets) so that the lazy boundary is handled
// transparently to callers.
const MotionZonesSettingsLazy = lazy(() =>
  import('../composites/cap-settings/MotionZonesSettings.js').then((m) => ({
    default: m.MotionZonesSettings,
  })),
)

const PrivacyMaskSettingsLazy = lazy(() =>
  import('../composites/cap-settings/PrivacyMaskSettings.js').then((m) => ({
    default: m.PrivacyMaskSettings,
  })),
)

/** Host widgets — ui-library React components embeddable as a
 *  `type:'widget'` ConfigField. `WidgetSlot` resolves these BEFORE the
 *  Module-Federation `WidgetRegistry`. ids are namespaced `host/<name>`. */
export const HOST_WIDGETS: Readonly<Record<string, ComponentType<HostWidgetProps>>> = {
  'host/motion-zones-grid': MotionZonesSettingsLazy,
  'host/privacy-mask-grid': PrivacyMaskSettingsLazy,
  'host/ptz-panel': PtzPanel,
  'host/navigation-panel': NavigationPanel,
  'host/consumables-panel': ConsumablesPanel,
  'host/ptz-autotrack': AutotrackSection,
  'host/recording-panel': RecordingPanel,
  'host/camera-grid-layout': CameraGridLayoutEditor,
  // `videoclips` — the first WRAPPER cap to declare a `host/` widget. Its
  // binding entry arrives `kind:'wrapped'`, which no shipped widget cap had
  // exercised; `device-config-widget-wrapped-binding.spec.ts` pins the derive.
  'host/clips-browser': ClipsSection,
  // `device-extension` (D648) — what a device is extended with by other
  // devices; one card per slot, each read and written by the slot's owner.
  'host/extensions-panel': ExtensionsPanel,
}
