/** The live state of a mesh provider as badges: Joined / Not joined, peer count, a daemon error. */
import type { ReactElement } from 'react'
import { Badge } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { STATUS_BADGE_CLASS } from '../integration-hub/addon-controls'
import { useMeshStatus } from './use-mesh-status'

export function MeshStatusBadges({ addonId }: { readonly addonId: string }): ReactElement {
  const { t } = useTranslation()
  const { status } = useMeshStatus(addonId)
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant={status.joined ? 'success' : 'default'} className={STATUS_BADGE_CLASS}>
        {status.joined
          ? t('system.meshNetworks.joined', 'Joined')
          : t('system.meshNetworks.notJoined', 'Not joined')}
      </Badge>
      {status.joined && (
        <Badge className={STATUS_BADGE_CLASS}>
          {t('common.peers', { count: status.peerCount })}
        </Badge>
      )}
      {status.error !== undefined && (
        <Badge variant="danger" className={STATUS_BADGE_CLASS} title={status.error}>
          {t('system.meshNetworks.error', 'Error')}
        </Badge>
      )}
    </span>
  )
}
