/**
 * The Secrets page's operations — each confirmed, each refreshing the page
 * afterwards. Kept out of the page so the page is only composition.
 */
import { KEYCHAIN_RESET_CONFIRMATION } from '@camstack/types'
import {
  useAlert,
  useConfirm,
  useKeychainAdminAcknowledgeReset,
  useKeychainAdminDeleteOrphans,
  useKeychainAdminDownloadRecoveryKey,
  useKeychainAdminPurgeRetiredKeys,
  useKeychainAdminResetKeychain,
  useKeychainAdminRotateMasterKey,
  usePrompt,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface KeychainActions {
  readonly busy: boolean
  readonly deleting: boolean
  readonly download: () => Promise<void>
  readonly rotate: () => Promise<void>
  readonly purge: () => Promise<void>
  readonly reset: () => Promise<void>
  readonly acknowledgeReset: () => Promise<void>
  readonly deleteOrphans: (refs: readonly string[]) => Promise<void>
}

export function useKeychainActions(refresh: () => void): KeychainActions {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const alert = useAlert()
  const prompt = usePrompt()
  const downloadM = useKeychainAdminDownloadRecoveryKey()
  const rotateM = useKeychainAdminRotateMasterKey()
  const purgeM = useKeychainAdminPurgeRetiredKeys()
  const resetM = useKeychainAdminResetKeychain()
  const ackM = useKeychainAdminAcknowledgeReset()
  const orphansM = useKeychainAdminDeleteOrphans()

  const guarded = async (title: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (err: unknown) {
      await alert({ title, message: messageOf(err), variant: 'danger' })
    }
    refresh()
  }

  const download = async (): Promise<void> => {
    const ok = await confirm({
      title: t('secrets.useKeychainActions.downloadTitle'),
      message: t('secrets.useKeychainActions.downloadMessage'),
      confirmLabel: t('secrets.useKeychainActions.downloadConfirm'),
      variant: 'warning',
    })
    if (!ok) return
    await guarded(t('secrets.useKeychainActions.downloadRefused'), async () => {
      const result = await downloadM.mutateAsync({})
      await prompt({
        title: t('secrets.useKeychainActions.recoveryTitle', { fingerprint: result.fingerprint }),
        message: t('secrets.useKeychainActions.recoveryMessage'),
        defaultValue: result.key,
        readOnly: true,
        confirmLabel: t('secrets.useKeychainActions.recoveryDone'),
      })
    })
  }

  const rotate = async (): Promise<void> => {
    const ok = await confirm({
      title: t('secrets.useKeychainActions.rotateTitle'),
      message: t('secrets.useKeychainActions.rotateMessage'),
      confirmLabel: t('secrets.useKeychainActions.rotateConfirm'),
      variant: 'warning',
    })
    if (!ok) return
    await guarded(t('secrets.useKeychainActions.rotateRefused'), async () => {
      const result = await rotateM.mutateAsync({})
      await alert({
        title: t('secrets.useKeychainActions.rotatedTitle'),
        message: t('secrets.useKeychainActions.rotatedMessage', {
          fingerprint: result.fingerprint,
        }),
      })
    })
  }

  const purge = async (): Promise<void> => {
    const ok = await confirm({
      title: t('secrets.useKeychainActions.purgeTitle'),
      message: t('secrets.useKeychainActions.purgeMessage'),
      confirmLabel: t('secrets.useKeychainActions.purgeConfirm'),
      variant: 'warning',
    })
    if (!ok) return
    await guarded(t('secrets.useKeychainActions.purgeRefused'), async () => {
      await purgeM.mutateAsync({})
    })
  }

  const reset = async (): Promise<void> => {
    const typed = await prompt({
      title: t('secrets.useKeychainActions.resetTitle'),
      message: t('secrets.useKeychainActions.resetMessage', {
        confirmation: KEYCHAIN_RESET_CONFIRMATION,
      }),
      confirmLabel: t('secrets.useKeychainActions.resetConfirm'),
      validate: (v) =>
        v === KEYCHAIN_RESET_CONFIRMATION ? null : t('secrets.useKeychainActions.resetMismatch'),
    })
    if (typed !== KEYCHAIN_RESET_CONFIRMATION) return
    await guarded(t('secrets.useKeychainActions.resetRefused'), async () => {
      await resetM.mutateAsync({ confirm: KEYCHAIN_RESET_CONFIRMATION })
    })
  }

  const acknowledgeReset = async (): Promise<void> => {
    await guarded(t('secrets.useKeychainActions.dismissFailed'), async () => {
      await ackM.mutateAsync({})
    })
  }

  const deleteOrphans = async (refs: readonly string[]): Promise<void> => {
    const ok = await confirm({
      title: t('secrets.useKeychainActions.orphansTitle', { count: refs.length }),
      message: t('secrets.useKeychainActions.orphansMessage'),
      confirmLabel: t('secrets.useKeychainActions.orphansConfirm'),
      variant: 'danger',
    })
    if (!ok) return
    await guarded(t('secrets.useKeychainActions.orphansRefused'), async () => {
      const result = await orphansM.mutateAsync({ refs: [...refs] })
      if (result.kept.length > 0) {
        await alert({
          title: t('secrets.useKeychainActions.keptTitle'),
          message: t('secrets.useKeychainActions.keptMessage', {
            deleted: result.deleted.length,
            kept: result.kept.length,
          }),
        })
      }
    })
  }

  return {
    busy: downloadM.isPending || rotateM.isPending || purgeM.isPending || resetM.isPending,
    deleting: orphansM.isPending,
    download,
    rotate,
    purge,
    reset,
    acknowledgeReset,
    deleteOrphans,
  }
}
