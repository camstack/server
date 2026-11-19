/**
 * <OpenPageQuickAction> — the row-level "open this device's page" button.
 *
 * A row click opens the host's quick-detail modal; this is the way from the
 * row straight to the device page. It is a bare icon at the end of the run of
 * the row's quick actions (an arrow out of the row), and it never starts the
 * row's own click.
 */
import { ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { IconButton } from '../../primitives/icon-button'

export interface OpenPageQuickActionProps {
  readonly deviceId: number
  readonly onOpenPage: (deviceId: number) => void
}

export function OpenPageQuickAction({ deviceId, onOpenPage }: OpenPageQuickActionProps): ReactNode {
  const t = useUiText()
  const label = t('uiLibrary.openPageQuickAction.open', 'Open device page')
  return (
    <IconButton
      type="button"
      variant="ghost"
      size="sm"
      icon={ArrowUpRight}
      aria-label={label}
      title={label}
      data-testid="device-row-open-page"
      onClick={(e) => {
        e.stopPropagation()
        onOpenPage(deviceId)
      }}
    />
  )
}
