/**
 * PtzPanel — live pan/tilt/zoom controls for the `ptz` capability. A
 * cap-settings component (ui-library), mounted as a cap-contributed
 * top-level device-detail tab via the cap-UI contribution mechanism
 * (the `ptz` cap declares `ui: { tab: 'ptz', kind: 'static', ... }`).
 *
 * Consolidates the former admin-ui `PTZPanelContent`: `usePTZ` drives
 * the controls, `PTZOverlay` renders them (`mode='panel'`), and an
 * Autofocus toggle is shown only when `getOptions().hasAutofocus`.
 * Autotrack is its own cap-UI contribution (`ptz-autotrack`), mounted
 * independently by the contribution mechanism — not nested here.
 */
import { useCallback, useEffect, useState, type JSX } from 'react'
import { Move } from 'lucide-react'
import type { PtzStatus } from '@camstack/types'
import { useSystem } from '../../contexts/system-context'
import { useUiText } from '../../contexts/ui-text'
import { usePTZ } from '../../hooks/use-ptz'
import { HomePresetPicker } from './HomePresetPicker'
import { useDeviceProxy } from '../../hooks/use-device-proxy'
import { PTZOverlay } from '../ptz-overlay'
import { WidgetPanel } from '../widget-panel'
import type { CapSettingsComponentProps } from './index'

/** Autofocus toggle — only mounted when `hasAutofocus`. Reads the cap's
 *  `getStatus().autofocus` and drives `setAutofocus`. */
function AutofocusToggle({ deviceId }: { readonly deviceId: number }) {
  const t = useUiText()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!dev) return undefined
    let cancelled = false
    void (async () => {
      try {
        const status = await dev.ptz?.getStatus({})
        if (cancelled || !status) return
        // getStatus output is typed `unknown` by the codegen'd router;
        // narrow via the cap's status schema — documented type boundary.
        const typed = status as PtzStatus
        setEnabled(typed.autofocus)
      } catch {
        /* camera without the cap — toggle stays hidden via hasAutofocus */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dev])

  const toggle = useCallback(async () => {
    if (!dev?.ptz || enabled === null) return
    setBusy(true)
    try {
      const next = !enabled
      await dev.ptz.setAutofocus({ enabled: next })
      setEnabled(next)
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('ptz.setAutofocus failed', err)
    } finally {
      setBusy(false)
    }
  }, [dev, enabled])

  if (enabled === null) return null

  // No own horizontal padding — the toggle flows inside the section
  // card's `p-3`, identical to the PTZOverlay above it. A self-applied
  // `px-3` would double the inset and make the `border-t` divider
  // appear to escape the padded content edge.
  return (
    <div className="flex items-center justify-between border-t border-border/40 mt-2 pt-2">
      <span className="text-[10.5px] font-semibold text-foreground">
        {t('uiLibrary.ptzPanel.autofocus', 'Autofocus')}
      </span>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={enabled}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
          enabled
            ? 'bg-success/15 text-success hover:bg-success/25'
            : 'bg-surface-elevated/40 text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
        } disabled:opacity-50`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            enabled ? 'bg-success' : 'bg-foreground-subtle/40'
          }`}
        />
        {enabled ? t('uiLibrary.ptzPanel.on', 'On') : t('uiLibrary.ptzPanel.off', 'Off')}
      </button>
    </div>
  )
}

export function PtzPanel({ deviceId }: CapSettingsComponentProps): JSX.Element | null {
  const t = useUiText()
  const system = useSystem()
  const ready = Number.isFinite(deviceId)
  const controls = usePTZ(system.trpcClient, ready ? deviceId : 0, { enabled: ready })

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-foreground-subtle italic">
        {t('uiLibrary.ptzPanel.notLoaded', 'Device #{{deviceId}} not loaded.', { deviceId })}
      </div>
    )
  }

  const hasAutofocus = controls.options?.hasAutofocus === true

  // `mode='panel'` drops the absolute positioning + dark pill; the
  // WidgetPanel card provides the chrome (title header + padded body).
  // The Autofocus toggle is gated by the cap's `getOptions().hasAutofocus`.
  return (
    <WidgetPanel
      title="PTZ"
      icon={<Move className="h-3.5 w-3.5 text-foreground-subtle" />}
      bodyClassName="p-3 flex flex-col overflow-y-auto"
    >
      <PTZOverlay controls={controls} mode="panel" />
      <HomePresetPicker controls={controls} />
      {hasAutofocus && <AutofocusToggle deviceId={deviceId} />}
    </WidgetPanel>
  )
}
