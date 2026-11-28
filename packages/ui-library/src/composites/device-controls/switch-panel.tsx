import { useState, type ReactNode, type CSSProperties } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useDeviceCommand } from '../../hooks/use-device-command'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import type { SwitchStatus } from '@dominevo/types'
import type { ControlPanelProps } from './types'

export function SwitchPanel({ trpc, deviceId }: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<
    { setState: (i: { on: boolean }) => Promise<void> },
    SwitchStatus
  >({
    trpc,
    deviceId,
    cap: (d) => d.switch as { setState: (i: { on: boolean }) => Promise<void> } | undefined,
    slice: (d) => d.state.switch,
  })
  const display = slice
  const runCommand = useDeviceCommand()
  const [pending, setPending] = useState(false)
  if (display === undefined) return null
  const on = display.on === true
  const busy = pending || !available
  const knob: CSSProperties = {
    transform: on ? 'translateX(14px)' : 'translateX(2px)',
  }
  const toggle = (): void => {
    if (busy || !cap) return
    const next = !on
    setPending(true)
    runCommand(() => cap.setState({ on: next }).finally(() => setPending(false)))
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      title={
        on
          ? t('uiLibrary.switchPanel.turnOff', 'Turn off')
          : t('uiLibrary.switchPanel.turnOn', 'Turn on')
      }
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        void toggle()
      }}
      className={cn(
        'relative inline-flex h-4 w-7 items-center rounded-full border transition-colors flex-shrink-0',
        on ? 'bg-success/30 border-success/50' : 'bg-surface-hover border-border',
        busy && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'absolute h-3 w-3 rounded-full transition-all',
          on ? 'bg-success' : 'bg-foreground-subtle',
        )}
        style={knob}
      />
    </button>
  )
}
