import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { MousePointerClick } from 'lucide-react'
import { useDeviceProxy } from '../../hooks/use-device-proxy'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'

/**
 * ButtonControl (inline) — compact "Press" trigger for a device-list row.
 *
 * The `button` cap is fire-only (no status / runtimeState), so we bypass
 * `useDeviceCapability` (which requires a slice) and resolve the cap
 * handle directly from the device proxy. We guard on `cap === undefined`
 * (device has no button cap) and render nothing in that case.
 */
export function ButtonControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const dev = useDeviceProxy(trpc, deviceId)
  const cap = dev !== null ? dev.button : undefined

  if (cap === undefined) return null

  const handlePress = (): void => {
    void cap.press({ deviceId })
  }

  return (
    <button
      type="button"
      aria-label={t('uiLibrary.buttonControl.press', 'Press')}
      title={t('uiLibrary.buttonControl.press', 'Press')}
      onClick={(e) => {
        e.stopPropagation()
        handlePress()
      }}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded px-1.5 text-xs',
        'bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
      )}
    >
      <MousePointerClick className="h-3 w-3" />
      <span>{t('uiLibrary.buttonControl.press', 'Press')}</span>
    </button>
  )
}

/**
 * ButtonHeroCard — large press-actuator card for the device-detail hero area.
 *
 * Renders a centred "Press" button with real design-token classes. The cap is
 * fire-only so no state display is needed — the affordance IS the control.
 */
export function ButtonHeroCard({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const dev = useDeviceProxy(trpc, deviceId)
  const cap = dev !== null ? dev.button : undefined

  if (cap === undefined) return null

  const handlePress = (): void => {
    void cap.press({ deviceId })
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-surface p-6">
      <button
        type="button"
        aria-label={t('uiLibrary.buttonControl.pressButton', 'Press button')}
        onClick={handlePress}
        className={cn(
          'inline-flex h-14 w-14 items-center justify-center rounded-full',
          'bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
          'shadow-md',
        )}
      >
        <MousePointerClick className="h-6 w-6" />
      </button>
      <span className="text-sm font-medium text-foreground">
        {t('uiLibrary.buttonControl.press', 'Press')}
      </span>
    </div>
  )
}
