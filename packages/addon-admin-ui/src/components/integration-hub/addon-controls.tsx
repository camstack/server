/**
 * The controls every addon-backed integration carries, identical on every
 * integration page: the Enabled/Disabled badge, the Enable/Disable toggle and
 * the Restart action.
 */
import { Loader2, Play, RefreshCw, Square } from 'lucide-react'
import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  ConfirmActionButton,
  useAddonsRestartAddon,
  useAddonsSetCapabilityProviderEnabled,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

/**
 * The two lists an integration page derives `isActive` from — the provider
 * registry (most pages) and the addon list (Connectivity reads process state).
 * Both are refreshed after a change so neither page shows the old state.
 */
const STATE_QUERY_KEYS = [[['addons', 'listCapabilityProviders']], [['addons', 'list']]] as const

/** A status pill at the size the integration chrome uses. */
export const STATUS_BADGE_CLASS = 'text-[10px]' as const

export function EnabledBadge({ isActive }: { readonly isActive: boolean }): ReactElement {
  const { t } = useTranslation()
  return (
    <Badge variant={isActive ? 'success' : 'default'} className={STATUS_BADGE_CLASS}>
      {isActive
        ? t('integrationHub.addonControls.enabled', 'Enabled')
        : t('integrationHub.addonControls.disabled', 'Disabled')}
    </Badge>
  )
}

/**
 * Flips the registry-level collection disabled-set via
 * `addons.setCapabilityProviderEnabled`; on success the provider list is
 * refetched so the page reflects the new `isActive`.
 */
export function EnableToggleButton({
  capName,
  addonId,
  isActive,
}: {
  readonly capName: string
  readonly addonId: string
  readonly isActive: boolean
}): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const setEnabled = useAddonsSetCapabilityProviderEnabled({
    onSuccess: () => {
      for (const queryKey of STATE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey })
    },
  })
  const isBusy = setEnabled.isPending
  return (
    <Button
      size="sm"
      variant={isActive ? 'secondary' : 'primary'}
      disabled={isBusy}
      onClick={() => setEnabled.mutate({ capName, addonId, enabled: !isActive })}
    >
      {isBusy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : isActive ? (
        <Square className="h-3 w-3" />
      ) : (
        <Play className="h-3 w-3" />
      )}
      {isActive ? t('common.disable', 'Disable') : t('common.enable', 'Enable')}
    </Button>
  )
}

/**
 * Kernel-level addon restart — bounces the provider's subprocess so a wedged
 * daemon recovers without a hub restart. Two-step confirm.
 */
export function RestartButton({
  addonId,
  displayName,
}: {
  readonly addonId: string
  readonly displayName: string
}): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const restartAddon = useAddonsRestartAddon({
    onSuccess: () => {
      for (const queryKey of STATE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey })
    },
  })
  return (
    <ConfirmActionButton
      label={t('integrationHub.addonControls.restart', 'Restart')}
      icon={RefreshCw}
      size="sm"
      title={t('integrationHub.addonControls.restart2', 'Restart "{{displayName}}"?', {
        displayName,
      })}
      description={t(
        'integrationHub.addonControls.restartingTheAddonBouncesIts',
        'Restarting the addon bounces its subprocess — the provider will briefly drop and reconnect automatically.',
      )}
      confirmLabel={t('integrationHub.addonControls.restart', 'Restart')}
      triggerVariant="ghost"
      confirmVariant="danger"
      disabled={restartAddon.isPending}
      action={() => restartAddon.mutateAsync({ addonId })}
    />
  )
}
