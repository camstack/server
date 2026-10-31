import { useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { useNodesRenameNode, Button, Input } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

interface NodeInfoTabProps {
  readonly nodeId: string
  readonly name: string
  readonly hostname: string
  readonly platform: string
  readonly arch: string
  readonly cpuModel?: string | null
  readonly cpuCores: number
  readonly memoryMB: number
  readonly engines: readonly string[]
  readonly isHub: boolean
  readonly uptime?: number
  readonly localIps?: readonly string[]
  readonly rootPackage?: { readonly name: string; readonly version: string } | null
}

function formatUptime(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '—'
  const secs = Math.floor(ms / 1000)
  const days = Math.floor(secs / 86400)
  const hours = Math.floor((secs % 86400) / 3600)
  const mins = Math.floor((secs % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

export function NodeInfoTab(props: NodeInfoTabProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [newName, setNewName] = useState(props.name)
  const queryClient = useQueryClient()
  const renameMutation = useNodesRenameNode({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['nodes', 'topology']] })
    },
  })

  const ipv4 = (props.localIps ?? []).filter((ip) => !ip.includes(':'))
  const ipv6 = (props.localIps ?? []).filter((ip) => ip.includes(':'))

  const handleRename = async () => {
    if (!newName.trim() || newName === props.name) {
      setEditing(false)
      return
    }
    try {
      await renameMutation.mutateAsync({ nodeId: props.nodeId, name: newName.trim() })
      setEditing(false)
    } catch (err) {
      console.error('Rename failed:', err)
    }
  }

  const rows: [string, React.ReactNode][] = [
    ['Node ID', <span className="font-mono text-xs">{props.nodeId}</span>],
    [
      'Display Name',
      editing ? (
        <div className="flex items-center gap-1.5">
          <Input
            type="text"
            className="flex-1 px-2 py-0.5 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            disabled={renameMutation.isPending}
            autoFocus
          />
          <Button
            variant="unstyled"
            onClick={() => void handleRename()}
            disabled={renameMutation.isPending}
            className="p-0.5 text-success hover:bg-success/10 rounded"
            title={t('common.save', 'Save')}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="unstyled"
            onClick={() => setEditing(false)}
            className="p-0.5 text-muted-foreground hover:bg-muted rounded"
            title={t('common.cancel', 'Cancel')}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{props.name}</span>
          {!props.isHub && (
            <Button
              variant="unstyled"
              onClick={() => {
                setNewName(props.name)
                setEditing(true)
              }}
              className="p-0.5 text-muted-foreground hover:text-primary rounded"
              title={t('cluster.nodeInfoTab.rename', 'Rename')}
            >
              <Pencil className="h-3 w-3" />
            </Button>
          )}
        </div>
      ),
    ],
    ['Hostname', <span className="text-xs">{props.hostname}</span>],
    [
      'Role',
      props.isHub ? (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
          {t('cluster.nodeInfoTab.hub', 'Hub')}
        </span>
      ) : (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
          {t('cluster.nodeInfoTab.agent', 'Agent')}
        </span>
      ),
    ],
    [
      'Root Package',
      props.rootPackage ? (
        <span className="font-mono text-xs">
          {props.rootPackage.name}@{props.rootPackage.version}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
    ],
    [
      'Platform',
      <span className="text-xs">
        {props.platform} / {props.arch}
      </span>,
    ],
    [
      'CPU',
      <span className="text-xs">
        {props.cpuModel ?? '—'} ({t('cluster.nodeInfoTab.cores', { count: props.cpuCores })})
      </span>,
    ],
    [
      'Memory',
      <span className="text-xs">
        {props.memoryMB > 0
          ? t('cluster.nodeInfoTab.gb', '{{value1}} GB', {
              value1: (props.memoryMB / 1024).toFixed(1),
            })
          : '—'}
      </span>,
    ],
    ['Uptime', <span className="text-xs">{formatUptime(props.uptime)}</span>],
    [
      t('cluster.nodeInfoTab.installedRuntimes', 'Installed runtimes'),
      props.engines.length > 0 ? (
        <div
          className="flex flex-wrap gap-1"
          title={t(
            'cluster.nodeInfoTab.installedRuntimesHint',
            'Inference runtimes installed on this node. Its live inference devices are on Pipeline → Load balancing.',
          )}
        >
          {props.engines.map((e) => (
            <span
              key={e}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
            >
              {e}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
    ],
  ]

  if (ipv4.length > 0) {
    rows.push([
      'IPv4',
      <div className="flex flex-wrap gap-1.5">
        {ipv4.map((ip, i) => (
          <span key={`${ip}-${i}`} className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted">
            {ip}
          </span>
        ))}
      </div>,
    ])
  }
  if (ipv6.length > 0) {
    rows.push([
      'IPv6',
      <div className="flex flex-wrap gap-1.5">
        {ipv6.map((ip, i) => (
          <span
            key={`${ip}-${i}`}
            className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted truncate max-w-[280px]"
            title={ip}
          >
            {ip}
          </span>
        ))}
      </div>,
    ])
  }

  return (
    <div className="py-2">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([label, value], i) => (
            <tr key={label as string} className={i % 2 === 0 ? 'bg-muted/20' : ''}>
              <td className="py-1.5 px-2 text-xs font-medium text-muted-foreground w-28 align-top whitespace-nowrap">
                {label}
              </td>
              <td className="py-1.5 px-2">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
