/**
 * The modal that edits a composed device or helper: the shared card editor in
 * a full-height dialog. The Build page and a device's Customize tab both open it.
 */
import { ItemFormDialog } from '@camstack/ui-library'
import { Boxes } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CompositionBlockEditor } from './CompositionBlockEditor'

export interface ComposedDeviceEditDialogProps {
  /** The block being edited; `null` keeps the dialog closed. */
  readonly blockId: string | null
  readonly onClose: () => void
}

export function ComposedDeviceEditDialog({
  blockId,
  onClose,
}: ComposedDeviceEditDialogProps): ReactNode {
  const { t } = useTranslation()
  return (
    <ItemFormDialog
      open={blockId !== null}
      onClose={onClose}
      title={t('build.customDeviceTab.editComposedDevice', 'Edit composed device')}
      icon={Boxes}
      width="xl"
      testId="composed-device-editor"
      fill
    >
      {blockId !== null && <CompositionBlockEditor blockId={blockId} fillHeight />}
    </ItemFormDialog>
  )
}
