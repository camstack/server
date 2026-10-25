import { useTranslation } from 'react-i18next'
import { AlertOctagon, Check, Clock, Loader2, RefreshCw } from 'lucide-react'
import type { BulkUpdateItem, BulkUpdateItemStatus } from '@camstack/types'
import type { LucideIcon } from 'lucide-react'

interface AddonRowBadgeProps {
  readonly item: BulkUpdateItem
}

interface Variant {
  readonly icon: LucideIcon
  readonly bg: string
  readonly labelKey: string
  readonly spin?: boolean
}

const variants: Record<BulkUpdateItemStatus, Variant> = {
  queued: {
    icon: Clock,
    bg: 'bg-muted text-foreground-subtle',
    labelKey: 'addons.addonRowBadge.queued',
  },
  updating: {
    icon: Loader2,
    bg: 'bg-primary/10 text-primary',
    labelKey: 'addons.addonRowBadge.updating',
    spin: true,
  },
  'done-pending-restart': {
    icon: RefreshCw,
    bg: 'bg-amber-500/10 text-amber-700',
    labelKey: 'addons.addonRowBadge.pendingRestart',
  },
  done: { icon: Check, bg: 'bg-success/10 text-success', labelKey: 'addons.addonRowBadge.done' },
  failed: {
    icon: AlertOctagon,
    bg: 'bg-danger/10 text-danger',
    labelKey: 'addons.addonRowBadge.failed',
  },
}

export function AddonRowBadge({ item }: AddonRowBadgeProps) {
  const { t } = useTranslation()
  const v = variants[item.status]
  const Icon = v.icon
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded ${v.bg}`}
      title={item.error}
    >
      <Icon className={`w-2.5 h-2.5 ${v.spin ? 'animate-spin' : ''}`} />
      {t(v.labelKey)}
    </span>
  )
}
