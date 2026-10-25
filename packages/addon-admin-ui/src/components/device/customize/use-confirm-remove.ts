/**
 * Every card Remove asks first, like the tab's own "Remove
 * customization" (D676 ruling 16): the message names what goes, and says so
 * when the removal empties the customization — then it IS `coreBlocks.delete`.
 */
import { useConfirm } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

/** `what` names what is removed; `emptiesCustomization` when nothing is left afterwards. */
export type ConfirmRemove = (what: string, emptiesCustomization: boolean) => Promise<boolean>

export function useConfirmRemove(): ConfirmRemove {
  const { t } = useTranslation()
  const confirm = useConfirm()
  return (what, emptiesCustomization) =>
    confirm({
      title: t('customize.assign.removeConfirm.title'),
      message: emptiesCustomization
        ? `${t('customize.assign.removeConfirm.message', { what })} ${t('customize.assign.removeConfirm.last')}`
        : t('customize.assign.removeConfirm.message', { what }),
      confirmLabel: t('customize.assign.removeConfirm.confirm'),
      variant: 'danger',
    })
}
