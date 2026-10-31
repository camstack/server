/**
 * integration-columns — the generic `DeviceListColumn<Integration>[]` that
 * drives the `/integrations` list through the unified
 * `<DeviceList mode="generic">`.
 *
 * Replaces the bespoke `integrations-table.tsx`. Each integration row renders:
 *   - `name`    — expand chevron + ProviderIcon + display name + addonId hint
 *   - `devices` — device count (pluralized)
 *   - `status`  — StatusBadge (running / stopped / disabled)
 *
 * The whole ROW is clickable (navigates to the integration detail, wired in the
 * page via the generic list's `onRowClick`) — there is no per-row Settings
 * button. Expansion is owned by generic-mode's `isExpanded`/`renderExpanded` (a
 * full-width row under the integration); the chevron in the `name` cell drives
 * the page's single-open `onToggleExpand` and `stopPropagation`s so toggling
 * doesn't also navigate.
 */
import { type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { StatusBadge, type DeviceListColumn, Button } from '@camstack/ui-library'
import { ProviderIcon } from '../shared/ProviderIcon'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

export type IntegrationRowStatus = 'running' | 'stopped' | 'disabled'

/** A single integration row for the unified generic table. */
export interface Integration {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly enabled: boolean
  readonly status: IntegrationRowStatus
  readonly deviceCount: number
}

export interface IntegrationColumnsOptions {
  readonly isExpanded: (integration: Integration) => boolean
  readonly onToggleExpand: (addonId: string) => void
}

interface NameCellProps {
  readonly integration: Integration
  readonly expanded: boolean
  readonly onToggleExpand: (addonId: string) => void
}

function NameCell({ integration, expanded, onToggleExpand }: NameCellProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5">
      <Button
        variant="unstyled"
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleExpand(integration.addonId)
        }}
        aria-label={
          expanded
            ? t('integrations.integrationColumns.collapse', 'Collapse')
            : t('integrations.integrationColumns.expand', 'Expand')
        }
        aria-expanded={expanded}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </Button>
      <ProviderIcon type={integration.addonId} size="sm" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-semibold text-foreground">{integration.name}</span>
        <span className="truncate text-[10px] text-foreground-subtle">{integration.addonId}</span>
      </div>
    </div>
  )
}

/**
 * Build the integration-row columns for the unified generic table. Handlers
 * are injected so the page owns expand state (single-open via `?expand=`).
 * Row navigation to the integration detail is wired by the page on the generic
 * list's `onRowClick` (the whole row is the affordance — no Settings button).
 */
export function buildIntegrationColumns(
  options: IntegrationColumnsOptions,
): readonly DeviceListColumn<Integration>[] {
  const { isExpanded, onToggleExpand } = options
  return [
    {
      key: 'name',
      header: i18n.t('integrations.integrationColumns.integration', 'Integration'),
      headerClassName: 'w-[55%]',
      cell: (integration) => (
        <NameCell
          integration={integration}
          expanded={isExpanded(integration)}
          onToggleExpand={onToggleExpand}
        />
      ),
    },
    {
      key: 'devices',
      header: i18n.t('integrations.integrationColumns.devices', 'Devices'),
      headerClassName: 'w-[15%]',
      cellClassName: 'text-[11px] text-foreground-subtle',
      cell: (integration) =>
        i18n.t('integrations.integrationColumns.deviceCount', { count: integration.deviceCount }),
    },
    {
      key: 'status',
      header: i18n.t('integrations.integrationColumns.status', 'Status'),
      headerClassName: 'w-[15%]',
      cell: (integration) => <StatusBadge status={integration.status} />,
    },
  ]
}
