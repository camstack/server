/**
 * NodeCapabilitiesTable — one row per node: whether it runs detection and
 * audio. Decode limits live on Pipeline → node → Engine & decoder; reachable
 * host is on Nodes → General. The shared `DataTable` scrolls sideways on a
 * phone rather than turning into cards.
 */
import { DataTable, type DataColumn, Switch } from '@camstack/ui-library'
import {
  CAPABILITY_META,
  capabilityValue,
  type BoardNode,
  type PlacementActions,
} from './board-model'
import { NodeIdentity } from './NodeIdentity'
import { useTranslation } from 'react-i18next'

export interface NodeCapabilitiesTableProps {
  readonly nodes: readonly BoardNode[]
  readonly actions: PlacementActions
}

export function NodeCapabilitiesTable({ nodes, actions }: NodeCapabilitiesTableProps) {
  const { t } = useTranslation()
  const columns: readonly DataColumn<BoardNode>[] = [
    {
      key: 'node',
      header: t('placementBoard.nodeCapabilitiesTable.node', 'Node'),
      sortValue: (node) => node.name,
      render: (node) => <NodeIdentity node={node} />,
    },
    ...CAPABILITY_META.map(
      (meta): DataColumn<BoardNode> => ({
        key: meta.key,
        header: t(meta.labelKey),
        align: 'center',
        notSortableReason: 'A switch — sorting would move the row while it is being changed.',
        render: (node) => (
          <Switch
            aria-label={t('placementBoard.nodeCapabilitiesTable.on', '{{label}} on {{name}}', {
              label: t(meta.labelKey),
              name: node.name,
            })}
            title={t(meta.hintKey)}
            checked={capabilityValue(node.effective, meta.key)}
            disabled={actions.capabilityPending}
            onCheckedChange={(enabled) => actions.onToggleCapability(node.id, meta.key, enabled)}
          />
        ),
      }),
    ),
  ]
  return (
    <DataTable
      columns={columns}
      rows={nodes}
      rowKey={(node) => node.id}
      bordered={false}
      minWidthPx={720}
      rowClassName={(node) => (node.isOnline ? undefined : 'opacity-60')}
      emptyMessage={t(
        'placementBoard.nodeCapabilitiesTable.noClusterNodesReportingYet',
        'No cluster nodes reporting yet.',
      )}
    />
  )
}
