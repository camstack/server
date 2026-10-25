/**
 * Built-in row glyph for the host's quick-detail modal. Renders nothing
 * unless a `DeviceQuickDetailProvider` is mounted above — same "draw
 * nothing rather than something dead" rule as `AdminLinkQuickAction`.
 */
import { useUiText } from '../../contexts/ui-text'
import { Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { useDeviceQuickDetailOpen } from '../../contexts/device-quick-detail'
import { cn } from '../../lib/cn'

export interface DeviceQuickDetailActionProps {
  readonly deviceId: number
  readonly className?: string
}

export function DeviceQuickDetailAction({
  deviceId,
  className,
}: DeviceQuickDetailActionProps): ReactNode {
  const t = useUiText()
  const open = useDeviceQuickDetailOpen()
  if (open === null) return null

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        open(deviceId)
      }}
      className={cn(
        'inline-flex items-center justify-center rounded text-foreground-subtle hover:text-foreground transition-colors flex-shrink-0',
        className,
      )}
      title={t('uiLibrary.deviceQuickDetail.label', 'Quick detail')}
      aria-label={t('uiLibrary.deviceQuickDetail.label', 'Quick detail')}
      data-testid="device-quick-detail"
    >
      <Settings className="h-3 w-3" />
    </button>
  )
}
