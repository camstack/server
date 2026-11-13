/**
 * The Restart action an addon-backed row carries (the instances table) and the
 * status-pill size the integration chrome shares.
 */
import { Loader2, RefreshCw } from 'lucide-react'
import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ConfirmActionButton,
  IconButton,
  useConfirm,
  useAddonsRestartAddon,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

/**
 * The two lists a row derives its state from — the provider registry and the
 * addon list (process state). Both are refreshed after a restart.
 */
const STATE_QUERY_KEYS = [[['addons', 'listCapabilityProviders']], [['addons', 'list']]] as const

/** A status pill at the size the integration chrome uses. */
export const STATUS_BADGE_CLASS = 'text-[10px]' as const

function useRestartAddon(): ReturnType<typeof useAddonsRestartAddon> {
  const queryClient = useQueryClient()
  return useAddonsRestartAddon({
    onSuccess: () => {
      for (const queryKey of STATE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey })
    },
  })
}

/** The row-action form of Restart. Its own component: `useConfirm` needs the dialog provider. */
function RestartIconButton({
  addonId,
  displayName,
  message,
}: {
  readonly addonId: string
  readonly displayName: string
  readonly message: string
}): ReactElement {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const restartAddon = useRestartAddon()
  return (
    <IconButton
      icon={restartAddon.isPending ? Loader2 : RefreshCw}
      variant="ghost"
      size="sm"
      aria-label={t('integrationHub.addonControls.restartNamed', 'Restart {{name}}', {
        name: displayName,
      })}
      disabled={restartAddon.isPending}
      onClick={() =>
        void confirm({
          title: t('integrationHub.addonControls.restart2', 'Restart "{{displayName}}"?', {
            displayName,
          }),
          message,
          confirmLabel: t('integrationHub.addonControls.restart', 'Restart'),
          variant: 'danger',
        }).then((ok) => (ok ? restartAddon.mutateAsync({ addonId }) : undefined))
      }
    />
  )
}

/**
 * Kernel-level addon restart — bounces the provider's subprocess so a wedged
 * daemon recovers without a hub restart. Two-step confirm.
 */
export function RestartButton({
  addonId,
  displayName,
  iconOnly = false,
  description,
}: {
  readonly addonId: string
  readonly displayName: string
  /** A row action: an icon button labelled "Restart <name>" instead of the text button. */
  readonly iconOnly?: boolean
  /** Replaces the default confirm text — a list row names the runner-group effect. */
  readonly description?: string
}): ReactElement {
  const { t } = useTranslation()
  const restartAddon = useRestartAddon()
  const confirmText =
    description ??
    t(
      'integrationHub.addonControls.restartingTheAddonBouncesIts',
      'Restarting the addon bounces its subprocess — the provider will briefly drop and reconnect automatically.',
    )
  if (iconOnly) {
    return <RestartIconButton addonId={addonId} displayName={displayName} message={confirmText} />
  }
  return (
    <ConfirmActionButton
      label={t('integrationHub.addonControls.restart', 'Restart')}
      icon={RefreshCw}
      size="sm"
      title={t('integrationHub.addonControls.restart2', 'Restart "{{displayName}}"?', {
        displayName,
      })}
      description={confirmText}
      confirmLabel={t('integrationHub.addonControls.restart', 'Restart')}
      triggerVariant="ghost"
      confirmVariant="danger"
      disabled={restartAddon.isPending}
      action={() => restartAddon.mutateAsync({ addonId })}
    />
  )
}
