/**
 * AI → Runtimes. Per-node `llm-runtime` status from `listRuntimeNodes`.
 *
 * A table rather than the `<ul>` of flex rows it was: the question this tab
 * answers is a comparison across nodes ("which one has the model on disk",
 * "which one is still downloading"), and a comparison read as prose is not a
 * comparison.
 */
import type { LlmRuntimeNode } from '@camstack/types'
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorBox,
  SECTION_BODY,
  SectionCard,
  Skeleton,
  TABLE_SCROLL_MAX_H,
  useSystem,
} from '@camstack/ui-library'
import type { DataColumn } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Server } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RUNTIME_NODES_KEY, runtimeNodeFeatures, runtimeStateTone } from './ai-page.helpers'
import i18n from '../../i18n/index'

const REFETCH_MS = 5_000

function gb(bytes: number): string {
  return i18n.t('system.aiRuntimes.sizeGb', {
    value: (bytes / 1_000_000_000).toFixed(1),
  })
}

export function AiRuntimesPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const nodesQuery = useQuery({
    queryKey: RUNTIME_NODES_KEY,
    refetchInterval: REFETCH_MS,
    queryFn: (): Promise<readonly LlmRuntimeNode[]> =>
      system.trpcClient.llm.listRuntimeNodes.query({}),
  })

  const columns = useMemo(
    (): readonly DataColumn<LlmRuntimeNode>[] => [
      {
        key: 'node',
        header: t('ai.colNode', 'Node'),
        render: (n) => <span className="font-medium text-foreground">{n.nodeId}</span>,
      },
      {
        key: 'state',
        header: t('ai.colState', 'State'),
        nowrap: true,
        render: (n) => (
          <span className="flex items-center gap-1.5">
            <Badge variant={runtimeStateTone(n)}>
              {n.reachable
                ? (n.status?.state ?? t('ai.ready', 'ready'))
                : t('ai.unreachable', 'unreachable')}
            </Badge>
            {n.status?.downloadProgress !== undefined && (
              <Badge variant="info">{`${String(Math.round(n.status.downloadProgress * 100))}%`}</Badge>
            )}
          </span>
        ),
      },
      {
        key: 'model',
        header: t('ai.colModel', 'Model'),
        render: (n) => <span className="text-foreground">{n.status?.modelId ?? '—'}</span>,
      },
      {
        key: 'disk',
        header: t('ai.colDisk', 'On disk'),
        align: 'right',
        nowrap: true,
        render: (n) => (
          <span className="tabular-nums text-foreground-muted">
            {n.disk !== undefined ? gb(n.disk.modelsBytes) : '—'}
          </span>
        ),
      },
      {
        key: 'features',
        header: t('ai.colFeatures', 'Features'),
        render: (n) => {
          const badges = runtimeNodeFeatures(n)
          if (badges.length === 0) return <span className="text-foreground-subtle">—</span>
          const details = badges.flatMap((b) => (b.detail !== null ? [b.detail] : []))
          return (
            <span className="flex flex-col items-start gap-0.5">
              <span className="flex flex-wrap gap-1">
                {badges.map((b) => (
                  <Badge key={b.id} variant={b.tone}>
                    {t(b.labelKey)}
                  </Badge>
                ))}
              </span>
              {details.length > 0 && (
                <span className="text-foreground-subtle">{details.join(' · ')}</span>
              )}
            </span>
          )
        },
      },
      {
        key: 'error',
        header: t('ai.colError', 'Error'),
        render: (n) =>
          n.error !== undefined ? (
            <span className="text-danger">{n.error}</span>
          ) : (
            <span className="text-foreground-subtle">—</span>
          ),
      },
    ],
    [t],
  )

  const nodes = nodesQuery.data ?? []

  return (
    <SectionCard headingId="ai-runtimes-list" title={t('ai.runtimesList', 'Nodes')}>
      {nodesQuery.isPending ? (
        <div className={`${SECTION_BODY} space-y-2`} data-testid="ai-runtimes-loading">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : nodesQuery.isError ? (
        <div className={SECTION_BODY}>
          <ErrorBox
            title={t('ai.runtimesFailed', 'Failed to read runtime nodes')}
            message={
              nodesQuery.error instanceof Error
                ? nodesQuery.error.message
                : t('common.error', 'Error')
            }
            onRetry={() => void nodesQuery.refetch()}
          />
        </div>
      ) : nodes.length === 0 ? (
        <EmptyState
          icon={Server}
          title={t('ai.noRuntimesTitle', 'No runtime nodes')}
          description={t('ai.noRuntimes', 'No node advertises the llm-runtime capability.')}
        />
      ) : (
        <DataTable<LlmRuntimeNode>
          columns={columns}
          rows={nodes}
          rowKey={(n) => n.nodeId}
          minWidthPx={760}
          bordered={false}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
        />
      )}
    </SectionCard>
  )
}
