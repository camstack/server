/**
 * AddonSettingsModal — modal-shell host for the existing
 * `NodeAddonsSettingsPanel`. Lets a page (e.g. Backup) open a
 * specific addon's `globalSettingsSchema` in a focused dialog
 * without navigating away to /system/settings.
 *
 * Single-addon scope by design — the panel can render multiple but
 * the modal pattern is "configure THIS one thing", so we narrow the
 * input to a single addonId. If a future caller needs N at once,
 * the underlying panel already accepts an array.
 */
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@camstack/ui-library'
import { NodeAddonsSettingsPanel } from './NodeAddonsSettingsPanel'

interface AddonSettingsModalProps {
  /** Addon manifest id whose global settings panel should render. */
  readonly addonId: string
  /** Title rendered in the modal header. Defaults to "Settings". */
  readonly title?: string
  /** Optional subtitle below the title. */
  readonly subtitle?: string
  readonly onClose: () => void
}

export function AddonSettingsModal({
  addonId,
  title = 'Settings',
  subtitle,
  onClose,
}: AddonSettingsModalProps) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" className="md:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <p className="text-xs text-foreground-subtle">{subtitle}</p>}
        </DialogHeader>
        <DialogBody>
          <NodeAddonsSettingsPanel nodeId={null} addonIds={[addonId]} level="global" />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
