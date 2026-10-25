/**
 * The unsaved-changes guard, as a hook: while the frame is dirty the browser
 * asks before a reload / tab close, and `guard(action)` asks (with the shared
 * confirm dialog) before an in-app action that would drop the edits — ←/→,
 * close, Escape.
 *
 * The decision itself is `runGuarded` (pure, `lib/retrain-dirty.ts`).
 */
import { useConfirm } from '@camstack/ui-library'
import { useCallback, useEffect } from 'react'
import { useT } from '../../i18n/index.js'
import { runGuarded } from './lib/retrain-dirty.js'

export function useUnsavedGuard(dirty: boolean): (proceed: () => void) => Promise<boolean> {
  const { t } = useT()
  const confirm = useConfirm()

  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [dirty])

  return useCallback(
    (proceed: () => void) =>
      runGuarded(
        dirty,
        () =>
          confirm({
            title: t('unsavedGuard.title'),
            message: t('unsavedGuard.message'),
            confirmLabel: t('unsavedGuard.confirm'),
            cancelLabel: t('unsavedGuard.cancel'),
            variant: 'danger',
          }),
        proceed,
      ),
    [dirty, confirm, t],
  )
}
