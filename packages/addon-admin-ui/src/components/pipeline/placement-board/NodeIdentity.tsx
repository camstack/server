import { useTranslation } from 'react-i18next'
/**
 * NodeIdentity — shared node label block (status dot + name + id + hub /
 * offline badges) used by both the mobile card header and the desktop table
 * row so the two layouts stay visually identical.
 */
import { Cpu, Server } from 'lucide-react'
import { Badge } from '@camstack/ui-library'
import type { BoardNode } from './board-model'

export interface NodeIdentityProps {
  readonly node: BoardNode
  readonly emphasis?: boolean
}

export function NodeIdentity({ node, emphasis = false }: NodeIdentityProps) {
  const { t } = useTranslation()
  const Icon = node.isHub ? Server : Cpu
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${node.isOnline ? 'bg-success' : 'bg-danger'}`}
        aria-hidden="true"
      />
      <Icon className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
      <div className="min-w-0">
        <div
          className={`flex items-center gap-1.5 ${emphasis ? 'text-sm' : 'text-xs'} font-semibold text-foreground`}
        >
          <span className="truncate">{node.name}</span>
          {node.isHub && (
            <Badge variant="info" className="px-1.5 py-0 text-[9px] uppercase tracking-wider">
              {t('common.hubWord')}
            </Badge>
          )}
          {!node.isOnline && (
            <Badge variant="danger" className="px-1.5 py-0 text-[9px] uppercase tracking-wider">
              {t('common.offline')}
            </Badge>
          )}
        </div>
        <div className="font-mono text-[10px] text-foreground-subtle truncate">{node.id}</div>
      </div>
    </div>
  )
}
