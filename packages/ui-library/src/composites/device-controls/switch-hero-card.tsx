import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { Power } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { SwitchStatus } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'
import { TapToggle } from './tap-toggle'

// ── Cap surface ───────────────────────────────────────────────────────────────
// Named cap type; the accessor performs the documented cap-access boundary
// narrowing (mirrors light-hero-card.tsx / lock-hero-card.tsx).

type SwitchCap = { setState: (i: { on: boolean }) => Promise<void> }

/**
 * SwitchHeroCard — large tap-toggle hero for Switch / Siren devices.
 *
 * Renders (Spec §3):
 *  - A power glyph tinted by on/off state (success when on, muted when off).
 *  - A large TAP TOGGLE for on/off — a single tap flips state. This is NOT a
 *    SlideToggle; slide-to-confirm is reserved for safety-gated locks ONLY.
 *
 * Cap-gated on `switch` — returns null when the device has no switch cap.
 */
export function SwitchHeroCard({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<SwitchCap, SwitchStatus>({
    trpc,
    deviceId,
    cap: (d) => d.switch as SwitchCap | undefined,
    slice: (d) => d.state.switch,
  })

  const { display, applyOptimistic } = useOptimisticSlice<SwitchStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined) return null
  if (display === undefined) return null

  const on = display.on === true
  const busy = !available

  const handleToggle = (): void => {
    if (busy) return
    const next = !on
    applyOptimistic({ on: next })
    void cap.setState({ on: next })
  }

  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-6">
      <div
        data-testid="switch-glyph"
        data-state={on ? 'on' : 'off'}
        className={cn(
          'flex h-16 w-16 items-center justify-center rounded-full border-2 transition-colors',
          on
            ? 'border-success/30 bg-success/10 text-success'
            : 'border-border bg-surface-subtle text-foreground-subtle',
        )}
      >
        <Power className="h-8 w-8" aria-hidden="true" />
      </div>

      <span className="text-sm font-medium text-foreground-muted">
        {on ? t('uiLibrary.switchHeroCard.on', 'On') : t('uiLibrary.switchHeroCard.off', 'Off')}
      </span>

      <TapToggle on={on} busy={busy} onToggle={handleToggle} />
    </div>
  )
}
