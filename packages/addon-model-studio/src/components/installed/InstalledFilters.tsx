/**
 * Installed filters: provider · step · device · node. The device filter lists
 * every device of the selected node (a disabled one is marked "off" — it may
 * still hold files) and keeps the rows whose format that device runs.
 */
import type { ReactNode } from 'react'
import {
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  SectionToolbar,
  Select,
  cn,
} from '@camstack/ui-library'
import type { ModelProviderId } from '@camstack/types'
import type { DeviceFilterOption } from '../../ui/installed-inventory.js'
import { NodeSelector } from '../NodeSelector.js'
import { useT } from '../../i18n/index.js'
import { providerLabel } from './provider-label.js'

export type InstalledProviderFilter = 'all' | ModelProviderId

export const PROVIDER_ORDER: readonly ModelProviderId[] = [
  'camstack',
  'scrypted',
  'frigate',
  'custom',
]

export interface InstalledFiltersProps {
  readonly provider: InstalledProviderFilter
  readonly onProvider: (next: InstalledProviderFilter) => void
  readonly step: string
  readonly stepOptions: readonly string[]
  readonly onStep: (next: string) => void
  readonly device: string
  readonly deviceOptions: readonly DeviceFilterOption[]
  readonly onDevice: (next: string) => void
  readonly nodeId: string
  readonly onNode: (next: string) => void
}

export function InstalledFilters(props: InstalledFiltersProps): ReactNode {
  const { t } = useT()
  const providerChoices: readonly {
    readonly value: InstalledProviderFilter
    readonly label: string
  }[] = [
    { value: 'all', label: t('installedFilters.all') },
    ...PROVIDER_ORDER.map((p) => ({ value: p, label: providerLabel(p, t) })),
  ]
  const deviceSelect = [
    { value: 'all', label: t('installedFilters.allDevices') },
    ...props.deviceOptions.map((o) => ({
      value: o.value,
      label: o.enabled
        ? `${o.label} · ${o.value}`
        : t('installedFilters.deviceOff', { label: o.label, value: o.value }),
    })),
  ]
  return (
    <SectionToolbar
      testId="installed-filters"
      className="sm:items-end"
      start={
        <>
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label={t('installedFilters.provider')}
            data-testid="installed-provider-filter"
          >
            {providerChoices.map((o) => (
              <button // ui-check-ok: CHIP_* filter pill; Button chrome breaks the segment
                key={o.value}
                type="button"
                aria-pressed={props.provider === o.value}
                onClick={() => props.onProvider(o.value)}
                className={cn(
                  CHIP_BASE,
                  'px-2',
                  props.provider === o.value ? CHIP_ACTIVE : CHIP_INACTIVE,
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="w-full min-w-0 sm:w-44">
            <Select
              aria-label={t('installedFilters.modelType')}
              data-testid="installed-type-filter"
              value={props.step}
              onChange={(e) => props.onStep(e.target.value)}
              options={[
                { value: 'all', label: t('installedFilters.allSteps') },
                ...props.stepOptions.map((id) => ({ value: id, label: id })),
              ]}
            />
          </div>
          <div className="w-full min-w-0 sm:w-52">
            <Select
              aria-label={t('installedFilters.device')}
              data-testid="installed-device-filter"
              value={props.device}
              onChange={(e) => props.onDevice(e.target.value)}
              options={deviceSelect}
            />
          </div>
        </>
      }
      end={
        <div className="min-w-0 max-w-full overflow-x-auto">
          <NodeSelector selectedNodeId={props.nodeId} onSelect={props.onNode} />
        </div>
      }
    />
  )
}
