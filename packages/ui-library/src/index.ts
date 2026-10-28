export * from './composites'
export * from './hotkeys'
export * from './contexts/custom-field-renderers'
export * from './contexts/device-context'
export * from './contexts/device-quick-detail'
export * from './contexts/player-overlays'
export * from './contexts/recorded-playback'
export * from './contexts/ui-text'
export {
  SystemProvider,
  type SystemProviderProps,
  useOptionalSystem,
  useSystem,
} from './contexts/system-context'
export * from './contexts/vod-playback'
export {
  loadRemoteBundle,
  useAllWidgets,
  useOptionalWidgetRegistry,
  useRemoteComponent,
  useWidget,
  useWidgetMetadata,
  useWidgetRegistry,
  type WidgetHost,
  type WidgetMetadataEntry,
  type WidgetProps,
  type WidgetRegistry,
  WidgetRegistryProvider,
  type WidgetRegistryProviderProps,
  type WidgetSize,
} from './contexts/widget-registry'
export * from './contexts/zone-editing'
export * from './generated/system-hooks'
export * from './hooks'
export * from './i18n'
export * from './icons'
export * from './lib'
export * from './primitives'
export * from './theme'
// `core-hooks` removed in Phase E — the 6 hand-written core routers
// are now caps so `system-hooks` covers them via the standard walker.
export { trpc } from './trpc-react'
export { HOST_WIDGETS, type HostWidgetProps } from './widgets/host-widgets'
export {
  classifyCapability,
  useCapabilityPresence,
  type CapabilityPresence,
} from './hooks/use-capability-presence'
export {
  AdminLinkQuickAction,
  type AdminLinkQuickActionProps,
  useDeviceAdminLink,
} from './composites/device-item/admin-link-quick-action'

// ─────────────────────────────────────────────────────────────────────────────
// Canvas composites — konva-dependent, exported LAZILY so they do NOT appear
// in the synchronous import graph.  Consumers that render these components
// must wrap them in <Suspense> (the WidgetSlot already does this for
// host-widget paths; ZoneOverlay in the orchestrator widget wraps with its
// own <Suspense>).
//
// These are exported from the ROOT index (not from composites/index.ts) so
// the composites barrel does NOT statically import react-konva, keeping the
// ~300 KB konva bundle off the first-paint chunk.
// ─────────────────────────────────────────────────────────────────────────────
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { CapSettingsComponentProps } from './composites/cap-settings/index.js'
import type { MaskShapeCanvasProps } from './composites/cap-settings/MaskShapeCanvas.js'
import type { SceneMonitorEditorProps } from './composites/cap-settings/SceneMonitorEditor.js'

/** Lazy-wrapped `MaskShapeCanvas` — code-split off the main bundle.
 *  Render inside `<Suspense>` at all call sites. */
export const MaskShapeCanvas: LazyExoticComponent<ComponentType<MaskShapeCanvasProps>> = lazy(() =>
  import('./composites/cap-settings/MaskShapeCanvas.js').then((m) => ({
    default: m.MaskShapeCanvas,
  })),
)

/** Lazy-wrapped `MotionZonesSettings` — code-split off the main bundle. */
export const MotionZonesSettings: LazyExoticComponent<ComponentType<CapSettingsComponentProps>> =
  lazy(() =>
    import('./composites/cap-settings/MotionZonesSettings.js').then((m) => ({
      default: m.MotionZonesSettings,
    })),
  )

/** Lazy-wrapped `SceneMonitorEditor` — code-split off the main bundle for the
 *  same reason: it mounts `MaskShapeCanvas`, which chains react-konva. Render
 *  inside `<Suspense>`; the admin-ui `/scenes` dialog is its only caller. */
export const SceneMonitorEditor: LazyExoticComponent<ComponentType<SceneMonitorEditorProps>> = lazy(
  () =>
    import('./composites/cap-settings/SceneMonitorEditor.js').then((m) => ({
      default: m.SceneMonitorEditor,
    })),
)

/** Lazy-wrapped `PrivacyMaskSettings` — code-split off the main bundle. */
export const PrivacyMaskSettings: LazyExoticComponent<ComponentType<CapSettingsComponentProps>> =
  lazy(() =>
    import('./composites/cap-settings/PrivacyMaskSettings.js').then((m) => ({
      default: m.PrivacyMaskSettings,
    })),
  )
