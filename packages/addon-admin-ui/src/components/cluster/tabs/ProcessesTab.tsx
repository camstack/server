/**
 * Cluster → Node → Processes tab — per-node OS process monitor.
 *
 * **Read-only.** This page exists to answer "what is this node's CPU and RSS
 * spent on, per addon". It performs no action on any process and offers no
 * control that could.
 *
 * Calls `metricsProvider.listNodeProcesses({nodeId})` which runs `ps` on
 * that node and cross-references with the kernel's `$process.list`. Rows
 * are classified as:
 *   - root    — the node's own supervisor process
 *   - managed — forked addon workers (tracked by `$process`), the rows whose
 *               load is attributable to a named addon
 *   - system  — every other camstack-shaped process on the machine: one the
 *               cluster did not spawn and cannot name
 *
 * ## What this page used to do, and why it does not (2026-08-27)
 *
 * There was a fourth class, `ghost`, with a red tile, a "recurring ghost
 * parents" panel, a Ghost-only filter, a red row tint and a "Kill all N
 * ghost(s)" bulk action — and per-row SIGTERM / SIGKILL buttons behind
 * `metricsProvider.killProcess`.
 *
 * The alarm went first, then the class: it produced 6 false positives out of 6
 * on the live cluster (the container's own `tini` at pid 1, and the operator's
 * desktop app with its Electron helpers), and it was the one class the kill
 * path allowed. Full reasoning, and where NOT to restart orphan detection
 * from: `packages/system/src/builtins/native-metrics/process-classification.ts`.
 *
 * The kill path went with it, for a reason that outlives the classifier: a
 * runner's lifecycle belongs to `CrashSupervisor` (D6). Signalling a raw pid
 * goes around it — the supervisor's respawn budget never sees the death, and
 * the runner comes back or does not on terms nobody chose. The legitimate
 * path already exists and stays: `addons.restartAddon`.
 */
import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'

import {
  DataTable,
  TABLE_SCROLL_MAX_H,
  useEventStreamLatest,
  useMetricsProviderListNodeProcesses,
  type DataColumn,
  Button,
} from '@camstack/ui-library'
import { formatBytes } from '../../../lib/format-size'
import { PROCESS_CLASS_RANK, type ProcessClassification } from './process-class-rank'
import { useTranslation } from 'react-i18next'

interface ProcessesTabProps {
  readonly nodeId: string
}

interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly classification: ProcessClassification
  readonly addonId: string | null
  readonly command: string
  readonly cpuPercent: number
  readonly memoryRssBytes: number
  readonly uptimeSec: number
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`
}

function shortCmd(cmd: string, limit = 80): string {
  if (cmd.length <= limit) return cmd
  return `…${cmd.slice(cmd.length - limit + 1)}`
}

export function ProcessesTab({ nodeId }: ProcessesTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Read process list directly from the snapshot event payload —
  // metrics-provider emits `metrics.node-processes-snapshot` ~5 s per
  // node. Bootstrap query primes the table on mount before the first
  // event lands.
  const processSnapshot = useEventStreamLatest<{
    nodeId: string
    processes: ReadonlyArray<ProcessRow>
    timestamp: number
  }>('metrics.node-processes-snapshot', (data) => data.nodeId === nodeId)

  const { data: bootstrapRows } = useMetricsProviderListNodeProcesses({ nodeId })

  const rawRows = processSnapshot?.processes ?? bootstrapRows

  const rows: ProcessRow[] = useMemo(() => (rawRows ? [...rawRows] : []), [rawRows])

  /**
   * Column model.
   *
   * Sortable: every column that has ONE value with an order — the two numeric
   * identities, the three load numbers, the addon name, and `Class` (by the
   * severity rank the tab already paints, not alphabetically).
   *
   * `Command` omits `sortValue` and is therefore not clickable. The reason
   * lives HERE and not in a header tooltip — it is design reasoning for whoever
   * next thinks of adding the sort, not something an operator needs at a
   * glance: a full argv line sorted alphabetically groups by interpreter path,
   * which is identical for nearly every row. It would look like an ordering
   * and convey nothing.
   */
  const columns: readonly DataColumn<ProcessRow>[] = useMemo(
    () => [
      {
        key: 'classification',
        header: t('cluster.processesTab.class', 'Class'),
        sortValue: (r) => PROCESS_CLASS_RANK[r.classification],
        render: (r) => (
          <span
            className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              r.classification === 'root'
                ? 'bg-info/20 text-info'
                : r.classification === 'system'
                  ? 'bg-foreground-subtle/20 text-foreground-subtle'
                  : 'bg-success/20 text-success'
            }`}
          >
            {r.classification}
          </span>
        ),
      },
      {
        key: 'pid',
        header: 'PID',
        align: 'right',
        sortValue: (r) => r.pid,
        render: (r) => <span className="font-mono">{r.pid}</span>,
      },
      {
        key: 'ppid',
        header: 'PPID',
        align: 'right',
        sortValue: (r) => r.ppid,
        render: (r) => <span className="font-mono text-foreground-subtle">{r.ppid}</span>,
      },
      {
        key: 'addonId',
        header: t('cluster.processesTab.addon', 'Addon'),
        // `null` for an unattributed process — it sorts last in both
        // directions rather than clumping under an invented empty string.
        sortValue: (r) => r.addonId,
        render: (r) => (
          <span className="text-foreground-subtle text-[11px]">{r.addonId ?? '—'}</span>
        ),
      },
      {
        key: 'command',
        header: t('cluster.processesTab.command', 'Command'),
        nowrap: false,
        render: (r) => (
          <span className="font-mono text-[10px] text-foreground-subtle break-all">
            {shortCmd(r.command)}
          </span>
        ),
      },
      {
        key: 'cpuPercent',
        header: t('cluster.processesTab.cpu', 'CPU%'),
        align: 'right',
        sortValue: (r) => r.cpuPercent,
        render: (r) => r.cpuPercent.toFixed(1),
      },
      {
        key: 'memoryRssBytes',
        header: 'RSS',
        align: 'right',
        // Sorts on the raw byte count, never on the formatted string —
        // "9 MB" sorts after "1 GB" as text.
        sortValue: (r) => r.memoryRssBytes,
        render: (r) => formatBytes(r.memoryRssBytes),
      },
      {
        key: 'uptimeSec',
        header: t('cluster.processesTab.uptime', 'Uptime'),
        align: 'right',
        sortValue: (r) => r.uptimeSec,
        render: (r) => (
          <span className="text-foreground-subtle">{formatDuration(r.uptimeSec)}</span>
        ),
      },
    ],
    [t],
  )

  return (
    <div className="space-y-4">
      {/* Refresh alone. The paragraph that used to sit beside it ("ps scan +
          kernel $process.list cross-reference; read-only") and the Root /
          Managed / System count tiles were removed on the operator's request:
          the `Class` column already carries the classification per row and is
          sortable by severity, so the tiles restated what the table shows and
          the paragraph described a mechanism nobody acts on. The page is still
          read-only — that is enforced by the absence of any control, and by
          `__tests__/ProcessesTab.spec.tsx`, not by a sentence. */}
      <div className="flex items-start justify-end gap-4">
        <Button
          variant="unstyled"
          type="button"
          onClick={() =>
            queryClient.invalidateQueries({ queryKey: [['metricsProvider', 'listNodeProcesses']] })
          }
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-surface-hover"
        >
          <RefreshCw className="h-3 w-3" /> {t('common.refresh')}
        </Button>
      </div>

      {/* The standard sortable `DataTable`: an internally-scrolling body with a
          pinned header (the process list runs to dozens of rows on a busy node,
          and a header that scrolls away leaves seven unlabelled numeric
          columns), and column sorting on every column that HAS an order.
          `Command` deliberately has none — the reason is in the column-model
          docblock above. */}
      <DataTable<ProcessRow>
        columns={columns}
        rows={rows}
        rowKey={(r) => r.pid}
        minWidthPx={880}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        emptyMessage={t('cluster.processesTab.scanning', 'Scanning…')}
      />
    </div>
  )
}
