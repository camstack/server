/**
 * The sub-header of the instances table: an "All" pill, then one per provider that holds
 * records — its icon, name, instance count and a dot for the worst status. A pill FILTERS the
 * table (it is a toggle, not a link); the install button sits on the right.
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
  readonly total: number
  /** The selected provider, or null for "All". */
  readonly selected: string | null
  readonly onSelect: (addonId: string | null) => void
  readonly fallbackIcon: LucideIcon
  readonly install?: InstanceInstallLink
  readonly addLabel: string
  readonly onAdd: () => void
  /** Why Add is disabled; when set, Add is shown disabled with this as helper text. */
  readonly addDisabledReason?: string
}

export function InstanceProviderPills({
  pills,
  total,
  selected,
  onSelect,
  fallbackIcon,
  install,
  addLabel,
  onAdd,
  addDisabledReason,
}: InstanceProviderPillsProps): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="px-3 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label={t('instances.filterByProvider', 'Filter by provider')}
          className="flex min-w-0 flex-wrap items-center gap-1.5"
        >
          <Button
            variant="unstyled"
            type="button"
            aria-pressed={selected === null}
            data-testid="instance-pill-all"
            onClick={() => onSelect(null)}
            className={`${PILL_BASE} pl-2.5 ${selected === null ? PILL_CURRENT : PILL_OTHER}`}
          >
            <span className="truncate">{t('instances.all', 'All')}</span>
            <span className="shrink-0 text-[10px] font-normal text-foreground-subtle">{total}</span>
          </Button>
          {pills.map((pill) => (
            <Button
              key={pill.addonId}
              variant="unstyled"
              type="button"
              aria-pressed={selected === pill.addonId}
              data-testid={`instance-pill-${pill.addonId}`}
              onClick={() => onSelect(pill.addonId)}
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
        <div className="flex flex-wrap items-center gap-2">
          {install !== undefined && (
            <Link
              to={addonCatalogHref(install.capability)}
              className={`${PILL_BASE} border-dashed border-border pl-2 text-foreground-subtle hover:border-primary/50 hover:text-foreground`}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{install.label}</span>
            </Link>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={addDisabledReason !== undefined}
            onClick={onAdd}
          >
            <Plus className="h-3.5 w-3.5" />
            {addLabel}
          </Button>
        </div>
      </div>
      {addDisabledReason !== undefined && (
        <p className="mt-1 text-right text-[11px] text-foreground-subtle">{addDisabledReason}</p>
      )}
    </div>
  )
}
