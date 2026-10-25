import { useUiText } from '../../contexts/ui-text'
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '../../lib/cn'

/**
 * TapToggle — plain tap-to-toggle on/off control.
 *
 * Spec §3: everyday on/off (switch, light, fan) uses a plain TAP TOGGLE.
 * slide-to-confirm is reserved for safety-gated actions (lock) ONLY. This
 * component must NEVER be built on `SlideToggle` — a single tap flips state.
 *
 * Presentational: the caller owns the cap mutation + optimistic update via
 * `onToggle`. Mirrors the `SwitchPanel` button treatment at hero scale.
 */
export interface TapToggleProps {
  readonly on: boolean
  readonly busy: boolean
  readonly onToggle: () => void
}

export function TapToggle({ on, busy, onToggle }: TapToggleProps): ReactNode {
  const t = useUiText()
  const knob: CSSProperties = { transform: on ? 'translateX(30px)' : 'translateX(3px)' }
  return (
    <button
      type="button"
      aria-pressed={on}
      title={
        on
          ? t('uiLibrary.tapToggle.turnOff', 'Turn off')
          : t('uiLibrary.tapToggle.turnOn', 'Turn on')
      }
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'relative inline-flex h-8 w-16 items-center rounded-full border transition-colors flex-shrink-0',
        on ? 'bg-success/30 border-success/50' : 'bg-surface-hover border-border',
        busy && 'opacity-60 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'absolute h-6 w-6 rounded-full transition-all',
          on ? 'bg-success' : 'bg-foreground-subtle',
        )}
        style={knob}
      />
    </button>
  )
}
