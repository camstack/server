/**
 * The cluster-wide settings an addon's dialog draws (#578): every cluster form of
 * the addon EXCEPT what a feature page claims (`lib/cluster-settings-claims.ts`),
 * with a link to each of those pages instead — one control per value.
 */
import { Button } from '@dominevo/ui-library'
import { useTranslation } from 'react-i18next'
import {
  addonDialogOmissions,
  CLUSTER_SETTINGS_SURFACE_ROUTES,
  featureClaimsOf,
  type ClusterSettingsSurface,
} from '../../lib/cluster-settings-claims'
import { NodeAddonsSettingsPanel } from '../settings/NodeAddonsSettingsPanel'

export interface AddonClusterSettingsProps {
  readonly addonId: string
  /** Navigate to an admin route. */
  readonly onOpen: (href: string) => void
}

export function AddonClusterSettings({ addonId, onOpen }: AddonClusterSettingsProps) {
  const { t } = useTranslation()
  const omissions = addonDialogOmissions(addonId)
  const claimedElsewhere = featureClaimsOf(addonId).length > 0
  return (
    <>
      <ClaimedElsewhereLinks addonId={addonId} onOpen={onOpen} />
      <NodeAddonsSettingsPanel
        nodeId={null}
        addonIds={[addonId]}
        level="global"
        fieldScope="cluster"
        omitCapabilities={omissions.capabilities}
        omitFieldKeys={omissions.fieldKeys}
        emptyMessage={
          claimedElsewhere
            ? t(
                'addons.addonCard.allClusterSettingsElsewhere',
                'Its cluster-wide settings are on the page linked above.',
              )
            : t(
                'addons.addonCard.thisAddonExposesNoCluster',
                'This addon exposes no cluster-wide settings. Anything it can configure is per-node — open it from Cluster → the node → Settings.',
              )
        }
      />
    </>
  )
}

interface ClaimedElsewhereLinksProps {
  readonly addonId: string
  readonly onOpen: (href: string) => void
}

/** The pages that draw some of this addon's cluster settings, one button each. */
function ClaimedElsewhereLinks({ addonId, onOpen }: ClaimedElsewhereLinksProps) {
  const { t } = useTranslation()
  const surfaces = [...new Set(featureClaimsOf(addonId).map((c) => c.surface))]
  if (surfaces.length === 0) return null
  const label = (surface: ClusterSettingsSurface): string => {
    switch (surface) {
      case 'pipeline':
        return t('addons.addonCard.surface.pipeline', 'Pipeline → Settings')
      case 'pipeline-roles':
        return t('addons.addonCard.surface.pipelineRoles', 'Pipeline → Roles & nodes')
      case 'history':
        return t('addons.addonCard.surface.history', 'History')
      case 'notifications':
        return t('addons.addonCard.surface.notifications', 'Notifications → Settings')
      case 'nodes':
        return t('addons.addonCard.surface.nodes', 'Nodes')
      default:
        return surface
    }
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-foreground-subtle">
      <span>
        {t('addons.addonCard.settingsElsewhere', "More of this addon's settings are on:")}
      </span>
      {surfaces.map((surface) => {
        const href = CLUSTER_SETTINGS_SURFACE_ROUTES[surface]
        if (href === undefined) return null
        return (
          <Button
            key={surface}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onOpen(href)}
          >
            {label(surface)}
          </Button>
        )
      })}
    </div>
  )
}
