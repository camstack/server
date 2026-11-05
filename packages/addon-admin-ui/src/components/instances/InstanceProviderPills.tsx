/**
 * The one pill row of the instances table: a pill per provider — its icon, name, instance count
 * and a dot for the worst status. A pill FILTERS the table (it is a toggle, not a link): nothing
 * selected shows every provider, and the active pill deselects when clicked again. There is no
 * "All" pill and no Add button here — Add lives in the page header. The row is not drawn when
 * there is a single provider (a lone pill filters nothing) and no install link to show.
 */
import { Button } from '@camstack/ui-library'
import { Plus, type LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link } from 'react-router-dom'
import { addonCatalogHref } from '../../lib/integration-hub-url'
import { PILL_BASE, PILL_CURRENT, PILL_OTHER } from '../HeaderPills'
import { AddonAssetIcon } from '../shared/AddonAssetIcon'
import type { InstanceHealth, InstancePill } from './instances-model'

const HEALTH_DOT: Record<InstanceHealth, string> = {
  ok: 'bg-success',
  off: 'bg-foreground-subtle/60',
  error: 'bg-danger',
  unknown: 'border border-foreground-subtle bg-transparent',
}

function healthLabel(t: TFunction, health: InstanceHealth): string {
  switch (health) {
    case 'ok':
      return t('instances.health.ok', 'Healthy')
    case 'error':
      return t('instances.health.error', 'Error')
    case 'off':
      return t('instances.health.off', 'Off')
    case 'unknown':
      return t('instances.health.unknown', 'Unknown')
  }
}

export interface InstanceInstallLink {
  /** The capability whose providers the add-on catalogue is filtered to. */
  readonly capability: string
  readonly label: string
}

export interface InstanceProviderPillsProps {
  readonly pills: readonly InstancePill[]
  /** The selected provider, or null when nothing is selected (every provider is listed). */
  readonly selected: string | null
  readonly onSelect: (addonId: string | null) => void
  readonly fallbackIcon: LucideIcon
  readonly install?: InstanceInstallLink
}

export function InstanceProviderPills({
  pills,
  selected,
  onSelect,
  fallbackIcon,
  install,
}: InstanceProviderPillsProps): ReactElement | null {
  const { t } = useTranslation()
  const showPills = pills.length > 1
  if (!showPills && install === undefined) return null
  return (
    <div className="px-3 pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {showPills && (
          <div
            role="group"
            aria-label={t('instances.filterByProvider', 'Filter by provider')}
            className="flex min-w-0 flex-wrap items-center gap-1.5"
          >
            {pills.map((pill) => (
              <Button
                key={pill.addonId}
                variant="unstyled"
                type="button"
                aria-pressed={selected === pill.addonId}
                data-testid={`instance-pill-${pill.addonId}`}
                onClick={() => onSelect(selected === pill.addonId ? null : pill.addonId)}
                className={`${PILL_BASE} ${selected === pill.addonId ? PILL_CURRENT : PILL_OTHER}`}
              >
                <AddonAssetIcon
                  addonId={pill.addonId}
                  fallback={fallbackIcon}
                  tileClassName=""
                  size="sm"
                />
                <span className="truncate">{pill.name}</span>
                <span className="shrink-0 text-[10px] font-normal text-foreground-subtle">
                  {pill.count}
                </span>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${HEALTH_DOT[pill.health]}`}
                  aria-hidden
                />
                <span className="sr-only">{healthLabel(t, pill.health)}</span>
              </Button>
            ))}
          </div>
        )}
        {install !== undefined && (
          <Link
            to={addonCatalogHref(install.capability)}
            className={`${PILL_BASE} border-dashed border-border pl-2 text-foreground-subtle hover:border-primary/50 hover:text-foreground`}
          >
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{install.label}</span>
          </Link>
        )}
      </div>
    </div>
  )
}
