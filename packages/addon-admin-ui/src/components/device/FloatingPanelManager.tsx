import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollText, Terminal, Bell, Move, Mic, Database, RotateCw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { FloatingPanel, useIsMobile } from '@camstack/ui-library'
import {
  LogsPanelContent,
  ReplPanelContent,
  EventsPanelContent,
  StatePanelContent,
  RestartPanelContent,
  PTZPanelContent,
  IntercomPanelContent,
} from './PanelContent'

// `stream` was a panel id when the live view was a togglable floating
// surface. After the layout rework it became the hero column of the
// page grid (always rendered), so it's no longer a panel here. The
// remaining shortcuts split into two families:
//   * cross-cutting dev/ops (logs/repl/events/state/restart)
//   * camera-specific overlays (ptz/intercom — gated by feature)
// Mobile renders NONE of these as floating overlays — the page-level
// `MobileShortcutTabRow` handles the cross-cutting ones inline, and
// the camera overlays open via the in-stream player buttons.
export type PanelId = 'logs' | 'repl' | 'events' | 'state' | 'restart' | 'ptz' | 'intercom'

interface PanelState {
  isOpen: boolean
  position: { x: number; y: number }
  size: { w: number; h: number }
}

interface PanelConfig {
  id: PanelId
  titleKey: string
  icon: LucideIcon
}

const PANEL_CONFIGS: PanelConfig[] = [
  { id: 'logs', titleKey: 'common.logs', icon: ScrollText },
  { id: 'repl', titleKey: 'device.floatingPanels.repl', icon: Terminal },
  { id: 'events', titleKey: 'common.events', icon: Bell },
  { id: 'state', titleKey: 'common.state', icon: Database },
  { id: 'restart', titleKey: 'common.restart', icon: RotateCw },
  { id: 'ptz', titleKey: 'device.floatingPanels.ptz', icon: Move },
  { id: 'intercom', titleKey: 'device.floatingPanels.intercom', icon: Mic },
]

const DEFAULT_PANEL_STATE: PanelState = {
  isOpen: false,
  position: { x: 80, y: 80 },
  size: { w: 400, h: 480 },
}

function getInitialPanelStates(): Record<PanelId, PanelState> {
  // All panels are always floating now — the docked-to-side-rail
  // affordance was removed (yields a single, predictable behavior
  // and frees the right edge for the new page-grid status column).
  // Each panel cascades to a slightly different default position so
  // simultaneous opens don't stack.
  return {
    logs: { ...DEFAULT_PANEL_STATE, position: { x: 120, y: 120 } },
    repl: { ...DEFAULT_PANEL_STATE, position: { x: 160, y: 160 } },
    events: { ...DEFAULT_PANEL_STATE, position: { x: 200, y: 200 } },
    state: { ...DEFAULT_PANEL_STATE, position: { x: 240, y: 240 } },
    // Restart is a 3-button card — much narrower than the streams.
    restart: { ...DEFAULT_PANEL_STATE, position: { x: 280, y: 280 }, size: { w: 320, h: 240 } },
    // PTZ defaults to bottom-right with a slimmer viewport — the
    // d-pad doesn't need a wide canvas.
    ptz: { ...DEFAULT_PANEL_STATE, position: { x: 600, y: 200 }, size: { w: 320, h: 280 } },
    // Intercom is a small PTT card — narrower than PTZ.
    intercom: { ...DEFAULT_PANEL_STATE, position: { x: 640, y: 480 }, size: { w: 300, h: 360 } },
  }
}

interface FloatingPanelManagerProps {
  /** Numeric device id — passed through to panel content components. */
  deviceId: number
  /** Externally controlled open panels — toggled from DeviceHeader */
  openPanelId: PanelId | null
  onPanelClosed: (id: PanelId) => void
  /** Toggle handler used by panel-internal triggers (e.g. the
   *  Intercom button rendered inside the stream player header). */
  onTogglePanel?: (id: PanelId) => void
  /** Device feature list — used to gate panel-internal UI affordances
   *  (e.g. only show the in-stream Intercom toggle when the device
   *  has TwoWayAudio). Typed as `string[]` because `device.features`
   *  is serialized as such across the wire; we compare against the
   *  `DeviceFeature.*` enum string values. */
  features?: readonly string[]
  children: React.ReactNode
}

export function FloatingPanelManager({
  deviceId,
  openPanelId,
  onPanelClosed,
  features: _features,
  children,
}: FloatingPanelManagerProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [panelStates, setPanelStates] = useState<Record<PanelId, PanelState>>(getInitialPanelStates)

  const updatePanel = useCallback((id: PanelId, patch: Partial<PanelState>) => {
    setPanelStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }))
  }, [])

  function handleClose(id: PanelId) {
    // Position/size persist across close-open cycles; only `isOpen` flips.
    updatePanel(id, { isOpen: false })
    onPanelClosed(id)
  }

  function handlePositionChange(id: PanelId, pos: { x: number; y: number }) {
    updatePanel(id, { position: pos })
  }

  function handleSizeChange(id: PanelId, size: { w: number; h: number }) {
    updatePanel(id, { size })
  }

  // Sync external toggle: open/close panels based on parent's openPanelId.
  // Only one panel open at a time when driven by the parent — clicking
  // a different shortcut closes the previous one first. (Multiple-open
  // is still possible later if needed; today's UX matches the previous
  // behavior of the old PANEL_BUTTONS row.)
  const prevOpenPanelId = useRef<PanelId | null>(null)
  useEffect(() => {
    const prev = prevOpenPanelId.current
    prevOpenPanelId.current = openPanelId

    if (prev !== null && prev !== openPanelId) {
      setPanelStates((s) => ({
        ...s,
        [prev]: { ...s[prev], isOpen: false },
      }))
    }
    if (openPanelId !== null) {
      setPanelStates((s) => ({
        ...s,
        [openPanelId]: { ...s[openPanelId], isOpen: true },
      }))
    }
  }, [openPanelId])

  function renderPanelContent(id: PanelId) {
    switch (id) {
      case 'logs':
        return <LogsPanelContent deviceId={deviceId} />
      case 'repl':
        return <ReplPanelContent deviceId={deviceId} />
      case 'events':
        return <EventsPanelContent deviceId={deviceId} />
      case 'state':
        return <StatePanelContent deviceId={deviceId} />
      case 'restart':
        return <RestartPanelContent deviceId={deviceId} />
      case 'ptz':
        return <PTZPanelContent deviceId={deviceId} />
      case 'intercom':
        return <IntercomPanelContent deviceId={deviceId} />
    }
  }

  // Mobile: render no floating overlays. The page-level
  // `MobileShortcutTabRow` handles the cross-cutting shortcuts
  // (logs/repl/events/state/restart) inline; camera-specific
  // overlays (ptz/intercom) are not exposed on mobile in this
  // iteration — the in-stream PTZ d-pad overlay is enough.
  if (isMobile) {
    return <div className="flex-1 overflow-y-auto p-4">{children}</div>
  }

  // Desktop / tablet: floating overlays only — the docked-to-side-rail
  // affordance was removed so the right edge stays free for the new
  // page-grid status column.
  const visiblePanels = PANEL_CONFIGS.filter(({ id }) => panelStates[id].isOpen)
  return (
    <>
      <div className="flex-1 overflow-y-auto p-6">{children}</div>
      {visiblePanels.map(({ id, titleKey, icon }) => {
        const state = panelStates[id]
        return (
          <FloatingPanel
            key={id}
            title={t(titleKey)}
            icon={icon}
            position={state.position}
            size={state.size}
            onClose={() => handleClose(id)}
            onPositionChange={(pos) => handlePositionChange(id, pos)}
            onSizeChange={(size) => handleSizeChange(id, size)}
          >
            <div className="p-3 text-xs">{renderPanelContent(id)}</div>
          </FloatingPanel>
        )
      })}
    </>
  )
}
