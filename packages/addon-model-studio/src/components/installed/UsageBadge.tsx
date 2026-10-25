/**
 * A file's usage on the node (`InstalledUsage`) and its copy state, as
 * library Badges. The words are the contract: "in use" means RESIDENT in a
 * pool, "unused" means no enabled device runs this format (reclaimable).
 */
import { Badge } from '@camstack/ui-library'
import type { InstalledUsage } from '../../ui/installed-inventory.js'
import { useT } from '../../i18n/index.js'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info'

type UsageKey = 'inUse' | 'configured' | 'idle' | 'unused' | 'outsidePools' | 'unknown'

const USAGE: Readonly<Record<InstalledUsage, { key: UsageKey; variant: BadgeVariant }>> = {
  'in-use': { key: 'inUse', variant: 'success' },
  configured: { key: 'configured', variant: 'info' },
  idle: { key: 'idle', variant: 'default' },
  unused: { key: 'unused', variant: 'warning' },
  'outside-pools': { key: 'outsidePools', variant: 'default' },
  unknown: { key: 'unknown', variant: 'default' },
}

const BADGE_SIZE = 'text-[10px] px-1.5 py-0'

export function UsageBadge({ usage }: { readonly usage: InstalledUsage }) {
  const { t } = useT()
  const u = USAGE[usage]
  return (
    <Badge
      variant={u.variant}
      className={BADGE_SIZE}
      title={t(`usage.${u.key}.title`)}
      data-usage={usage}
    >
      {t(`usage.${u.key}.label`)}
    </Badge>
  )
}

export function StaleBadge() {
  const { t } = useT()
  return (
    <Badge
      variant="warning"
      style="outline"
      className={`${BADGE_SIZE} border-warning/40`}
      title={t('usage.stale.title')}
    >
      {t('usage.stale.label')}
    </Badge>
  )
}

export function PrecisionBadge({ precision }: { readonly precision: string }) {
  const { t } = useT()
  return (
    <Badge
      style="outline"
      className={`${BADGE_SIZE} border-border text-foreground-subtle uppercase`}
      title={t('usage.precisionTitle')}
    >
      {precision}
    </Badge>
  )
}
