/**
 * NodeDetailPanel → Settings sub-tab.
 *
 * Renders the settings that are true of THIS MACHINE — nothing else.
 *
 * WHAT THIS TAB USED TO BE. It rendered every addon on the node at
 * `level: 'global'` with no field filter, which is a cluster-settings editor
 * with a node's name on it: of the fields it drew under an agent's heading,
 * the overwhelming majority were one value shared by the whole cluster, and a
 * Save on one node card silently reconfigured the others. `perNode: true` is
 * the only thing that scopes a value to a node
 * (`ConfigFieldBase.perNode` → `<key>@<nodeId>`); everything without it is a
 * single blob and the `nodeId` this tab passes is discarded on write.
 *
 * So the tab is narrowed to `fieldScope="perNode"`. For most nodes that makes
 * it SHORT, and for some addons empty — which is the correct answer, said out
 * loud. An empty tab that explains where the cluster settings live is strictly
 * better than a full one whose values do not belong to the node in its title;
 * the previous version was not more useful, it was more wrong.
 *
 * `selfTabbed` turns the surviving `section.tab` groups into a tab bar.
 */
import { NodeAddonsSettingsPanel } from '../../settings/NodeAddonsSettingsPanel'
import { useTranslation } from 'react-i18next'

interface NodeDetailSettingsTabProps {
  readonly nodeId: string
  readonly addonIds: readonly string[]
}

/** Said in full when a node has no per-node settings at all. */
const NO_PER_NODE_SETTINGS =
  'No per-node settings on this node. Every other setting these addons expose is ' +
  'one value for the whole cluster — edit those in System → Settings, not here.'

export function NodeDetailSettingsTab({ nodeId, addonIds }: NodeDetailSettingsTabProps) {
  const { t } = useTranslation()
  if (addonIds.length === 0) {
    return (
      <div className="py-4 text-xs text-muted-foreground text-center">
        {t('cluster.nodeDetailSettingsTab.noAddonsOnThisNode', 'No addons on this node')}
      </div>
    )
  }
  return (
    <div className="w-full py-2">
      <NodeAddonsSettingsPanel
        nodeId={nodeId}
        addonIds={addonIds}
        level="global"
        fieldScope="perNode"
        emptyMessage={NO_PER_NODE_SETTINGS}
        selfTabbed
      />
    </div>
  )
}
