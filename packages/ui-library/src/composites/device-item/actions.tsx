/**
 * <DeviceItemActions> — type-aware dispatcher for inline quick actions.
 *
 * Two layers compose the row's trailing affordances:
 *   1. Type-specific InlineControl: rendered directly from the
 *      `DEVICE_TYPE_CONTROL` registry (cover → ↑■↓ + %; all other
 *      non-sensor types → DummyInline which renders nothing visible).
 *      Sensor / Presence device rows display their live value via
 *      `SensorValueAtom` instead (needs device.role + sourceInfo which
 *      DeviceControlProps does not carry).
 *   2. Cross-cutting feature-gated extras (motion-trigger, PTZ, reboot)
 *      stay here — they gate on `device.features`, are device-type
 *      agnostic, and so are NOT in the per-type registry.
 *
 * High-frequency toggles stay inline. Reboot is a dedicated row-level
 * action button (`RebootQuickAction`) — destructive, so clicking it opens
 * a confirm modal rather than rebooting on the first click.
 *
 * Each atom self-gates via `useDeviceCapability` / the panel's own cap
 * lookup — the dispatcher is a coarse pre-flight only. An atom that
 * finds its cap unbound returns `null` so the row stays compact.
 */
import { useUiText } from '../../contexts/ui-text'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Gamepad2 } from 'lucide-react'
import { DeviceType } from '@camstack/types'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { usePTZ } from '../../hooks/use-ptz'
import { PTZOverlay } from '../ptz-overlay'
import {
  resolveDeviceControl,
  resolveControlAlign,
  type ControlPlacement,
} from '../device-controls/control-registry'
import { ControlColumn } from '../device-controls/atoms'
import { SensorValueAtom } from '../device-controls/sensor-value-atom'
import { resolveContainerPrimary } from '../device-controls/container-primary'
import { cn } from '../../lib/cn'
import type { DeviceItemDevice, VariantDefaults } from './helpers'
import { hasMotionTriggerFeature } from './helpers'
import { AdminLinkQuickAction } from './admin-link-quick-action'
import { RebootQuickAction } from './reboot-quick-action'
import { useContainerChildren } from './container-children-context'

/** DeviceTypes whose row display is the live sensor value, not a control. */
const SENSOR_VALUE_TYPES: ReadonlySet<string> = new Set<string>([
  DeviceType.Sensor,
  DeviceType.Presence,
])

export interface DeviceItemActionsProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly device: DeviceItemDevice
  readonly flags: VariantDefaults
  /**
   * Where the control sits and whether the column carries the fixed `w-[140px]`
   * box. `'right'` (default) → flush right in the fixed column, for card /
   * minimal views. `'center'` → centered in the fixed column. `'table'` → the
   * column sizes to its content (no fixed width) so a wide control lays out in
   * sequence with the trailing trash + status dot without overflowing/colliding
   * — used by the main devices table. FILL controls stretch to the fixed column
   * width under `'right'`/`'center'`; under `'table'` they take natural width.
   */
  readonly controlPlacement?: ControlPlacement
}

export function DeviceItemActions({
  trpc,
  device,
  controlPlacement,
}: DeviceItemActionsProps): ReactNode {
  // A Container renders AS its primary child; resolve the child set from the
  // list-level context rather than a threaded prop. Hooks must run before the
  // early returns below, so read it here unconditionally.
  const containerChildren = useContainerChildren(device.id)
  const placement: ControlPlacement = controlPlacement ?? 'right'
  const enabled = !device.disabled
  if (!enabled) return null

  // 0. Container row → render AS its primary child. Resolve the primary child
  //    (priority default, or the picker override persisted on
  //    `device.linkDeviceId`) and render that child's type-specific inline
  //    control bound to the CHILD's numeric id. A container with no resolvable
  //    primary child renders nothing (degrades gracefully).
  if (device.type === DeviceType.Container) {
    const primary = resolveContainerPrimary(
      containerChildren,
      device.linkDeviceId,
      device.primaryChildEntityId,
    )
    const primaryChild =
      primary === null ? undefined : containerChildren.find((c) => c.id === primary.id)
    if (primaryChild === undefined) return null
    return <ContainerPrimaryInline trpc={trpc} child={primaryChild} placement={placement} />
  }

  // 1. Type-specific inline control — from DEVICE_TYPE_CONTROL registry.
  //    Sensor / Presence rows show their live value via SensorValueAtom
  //    (which needs device.role + sourceInfo). All other types use the
  //    registry's InlineControl directly (cover → ↑■↓; rest → DummyInline).
  const isSensorRow = SENSOR_VALUE_TYPES.has(device.type)
  const control = isSensorRow ? null : resolveDeviceControl(device.type)
  const InlineControl = control?.InlineControl ?? null
  // Alignment for the uniform control column. FILL types stretch; natural-width
  // types are placed per `placement` (right for card view, center for table).
  const columnAlign = resolveControlAlign(device.type, placement)

  // 2. Cross-cutting feature-gated extras (device-type agnostic).
  const showOnMotion = hasMotionTriggerFeature(device)
  // Reboot was previously gated to hub/nvr — but plenty of cameras
  // advertise `rebootable` too and never surfaced the action. Gate on
  // the feature alone; `RebootQuickAction` self-gates on the actual
  // `reboot` cap binding, so a device that claims the feature without a
  // bound provider still renders nothing.
  const showReboot = (device.features ?? []).includes('rebootable')
  // PTZ quick-action: a floating popover with the movement d-pad +
  // presets (NO auto-track — that lives in the device-detail panel).
  const showPtz = (device.features ?? []).includes('pan-tilt-zoom')

  return (
    <>
      {isSensorRow && (
        <ControlColumn align={resolveControlAlign(device.type, placement)}>
          {showOnMotion && (
            <OnMotionToggle trpc={trpc} deviceId={device.id} features={device.features} />
          )}
          <SensorValueAtom trpc={trpc} device={device} />
        </ControlColumn>
      )}
      {InlineControl !== null && (
        // Stop clicks on inline controls (select/buttons/sliders) from bubbling
        // to the row's navigate-to-detail handler. The motion-trigger toggle
        // sits INSIDE the control column (before the control) so it's flush
        // against the switch/slider instead of stranded across the fixed-width
        // column's empty space.
        <ControlColumn align={columnAlign} onClick={(e) => e.stopPropagation()}>
          {showOnMotion && (
            <OnMotionToggle trpc={trpc} deviceId={device.id} features={device.features} />
          )}
          <InlineControl trpc={trpc} deviceId={device.id} features={device.features} />
        </ControlColumn>
      )}
      {!isSensorRow && InlineControl === null && showOnMotion && (
        <OnMotionToggle trpc={trpc} deviceId={device.id} features={device.features} />
      )}
      {showPtz && <PtzQuickAction trpc={trpc} deviceId={device.id} />}
      {showReboot && (
        <RebootQuickAction trpc={trpc} deviceId={device.id} deviceName={device.name} />
      )}
      {/*
        Last in the run, and the quietest thing in it. Unlike PTZ and reboot
        there is no feature flag to pre-gate on — "has a config page" is not a
        DeviceFeature and inventing one would be a second authority on a
        question the cap already answers. `AdminLinkQuickAction` self-gates on
        the cap binding, so nothing is queried for the devices that cannot
        answer, and it renders nothing until it has a real URL.
      */}
      <AdminLinkQuickAction trpc={trpc} deviceId={device.id} />
    </>
  )
}

// ── ContainerPrimaryInline ──────────────────────────────────────────
//
// Renders a container row AS its primary child: looks up the primary
// child's TYPE in the shared control registry and renders that
// InlineControl bound to the CHILD's numeric deviceId. The control is
// indistinguishable from a top-level device row of the same type — a
// lock-container renders the lock control, a climate-container the
// thermostat control, etc. Sensor / Presence primary children show
// their live value via SensorValueAtom (same special-case as a normal
// sensor row), since they need device.role + sourceInfo which the
// inline-control path does not carry.

interface ContainerPrimaryInlineProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly child: DeviceItemDevice
  readonly placement: ControlPlacement
}

function ContainerPrimaryInline({
  trpc,
  child,
  placement,
}: ContainerPrimaryInlineProps): ReactNode {
  const isSensorRow = SENSOR_VALUE_TYPES.has(child.type)
  if (isSensorRow) {
    // Mirror the sensor-row path: SensorValueAtom needs the full child row
    // (role + sourceInfo) to resolve its descriptor + live slice.
    return (
      <ControlColumn align={resolveControlAlign(child.type, placement)}>
        <SensorValueAtom trpc={trpc} device={child} />
      </ControlColumn>
    )
  }
  const control = resolveDeviceControl(child.type)
  const InlineControl = control?.InlineControl ?? null
  if (InlineControl === null) return null
  const columnAlign = resolveControlAlign(child.type, placement)
  return (
    <ControlColumn align={columnAlign} onClick={(e) => e.stopPropagation()}>
      <InlineControl trpc={trpc} deviceId={child.id} features={child.features} />
    </ControlColumn>
  )
}

// ── OnMotionToggle ──────────────────────────────────────────────────

interface OnMotionToggleProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  readonly features: readonly string[] | undefined
}

function OnMotionToggle({ trpc, deviceId, features }: OnMotionToggleProps): ReactNode {
  const t = useUiText()
  const { dev, cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.motionTrigger,
    slice: (d) => d.state.motionTrigger,
    requireFeature: 'motion-trigger',
    deviceFeatures: features,
  })
  const [pending, setPending] = useState(false)

  if (dev !== null && !cap) return null

  const on = slice?.enabled === true

  const handleClick = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (pending || !available || !cap) return
    setPending(true)
    try {
      await cap.setMotionTrigger({ enabled: !on })
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        void handleClick(e)
      }}
      disabled={pending || !available}
      className={cn(
        'inline-flex h-4 w-4 items-center justify-center rounded transition-colors flex-shrink-0',
        on
          ? 'text-primary bg-primary/10'
          : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
        (pending || !available) && 'opacity-50',
      )}
      title={
        !available
          ? t('uiLibrary.deviceItemActions.awaiting', 'Awaiting state…')
          : on
            ? t('uiLibrary.deviceItemActions.motionOn', 'Motion-trigger: on (click to disable)')
            : t('uiLibrary.deviceItemActions.motionOff', 'Motion-trigger: off (click to enable)')
      }
      aria-pressed={on}
    >
      <Activity className="h-2.5 w-2.5" />
    </button>
  )
}

// ── Shared positioning primitives (used by PtzQuickAction) ──────────
//
// PtzQuickAction anchors a portal-positioned popover under its trigger:
// `MenuPosition` is the fixed-position anchor and `MENU_GAP` the vertical
// offset below the trigger.

interface MenuPosition {
  readonly top: number
  readonly left: number
}

const MENU_GAP = 4

// ── PtzQuickAction (floating PTZ popover) ───────────────────────────
//
// A row-level affordance for pan/tilt/zoom-capable cameras: the
// trigger opens a portal-positioned popover hosting the shared
// `PTZOverlay` in `panel` mode (d-pad + zoom + home + presets). Auto-
// track is intentionally NOT here — it stays in the full device-detail
// panel; this is a quick "nudge the camera" surface from the list.
//
// Positioning mirrors `MoreActionsMenu`: fixed-position div on
// `document.body` so it escapes the table's `overflow` clip, anchored
// under the trigger, clamped inside the viewport (so it stays usable on
// mobile), height-capped with its own scroll. The underlying `usePTZ`
// network calls are gated on `isOpen` so closed rows never hit the cap.

interface PtzQuickActionProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
}

const PTZ_PANEL_WIDTH = 300

function PtzQuickAction({ trpc, deviceId }: PtzQuickActionProps): ReactNode {
  const t = useUiText()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<
    (MenuPosition & { readonly width: number; readonly maxHeight: number }) | null
  >(null)
  const isOpen = position !== null
  const controls = usePTZ(trpc, deviceId, { enabled: isOpen })

  const close = (): void => setPosition(null)
  const openPanel = (): void => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    const width = Math.min(PTZ_PANEL_WIDTH, window.innerWidth - margin * 2)
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))
    const top = rect.bottom + MENU_GAP
    const maxHeight = Math.max(160, window.innerHeight - top - margin)
    setPosition({ top, left, width, maxHeight })
  }

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (e: globalThis.MouseEvent | TouchEvent): void => {
      const trg = triggerRef.current
      const panel = panelRef.current
      const target = e.target as Node | null
      if (target === null) return
      if (trg && trg.contains(target)) return
      if (panel && panel.contains(target)) return
      close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen])

  const handleToggle = (e: MouseEvent): void => {
    e.stopPropagation()
    if (isOpen) close()
    else openPanel()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0',
          isOpen && 'bg-surface-hover text-foreground',
        )}
        title={t('uiLibrary.deviceItemActions.ptz', 'PTZ controls')}
        aria-label={t('uiLibrary.deviceItemActions.ptz', 'PTZ controls')}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <Gamepad2 className="h-3 w-3" />
      </button>
      {position &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            className="z-[9999] overflow-y-auto rounded-lg border border-border bg-surface shadow-lg shadow-black/30"
            onClick={(e) => e.stopPropagation()}
          >
            <PTZOverlay mode="panel" controls={controls} />
          </div>,
          document.body,
        )}
    </>
  )
}
