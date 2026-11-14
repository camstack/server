import type { DeviceSearchFacets } from '@camstack/types'
import { ChevronRight } from 'lucide-react'
import { type JSX, useState } from 'react'
import { Button } from '../../primitives/button'
import { useUiText } from '../../contexts/ui-text'
import { humanizeIdentifier } from '../../lib/capability-label'
import { cn } from '../../lib/cn'
import { Checkbox } from '../../primitives/checkbox'
import {
  type FacetKey,
  type FacetSelection,
  facetSummary,
  topFacetOptions,
} from './device-value-picker-model'
import { useIntegrationProviders } from './use-integration-providers'

/** Options a facet shows before "N more". */
const FACET_TOP = 5

interface FacetOption {
  readonly value: string
  readonly label: string
  readonly count: number
  /** Who offers an integration instance; absent when not known. */
  readonly detail?: string
}

interface FacetView {
  readonly key: FacetKey
  readonly name: string
  readonly options: readonly FacetOption[]
}

function facetViews(
  facets: DeviceSearchFacets,
  names: {
    readonly location: string
    readonly integration: string
    readonly type: string
  },
): readonly FacetView[] {
  return [
    {
      key: 'locations',
      name: names.location,
      options: facets.locations.map((f) => ({
        value: f.value,
        label: f.value,
        count: f.count,
      })),
    },
    {
      key: 'integrationIds',
      name: names.integration,
      options: facets.integrations.map((f) => ({
        value: f.id,
        label: f.label,
        count: f.count,
      })),
    },
    {
      key: 'types',
      name: names.type,
      options: facets.types.map((f) => ({
        value: f.value,
        label: humanizeIdentifier(f.value),
        count: f.count,
      })),
    },
  ]
}

/**
 * The popover's filter rail: exactly three generic facets (Location,
 * Integration, Type), each collapsed by default and showing its current
 * choice; expanded it lists the top options with counts and "N more". A
 * facet with nothing to choose between is not drawn.
 */
export function DeviceValueRail({
  facets,
  selection,
  onToggle,
}: {
  readonly facets: DeviceSearchFacets
  readonly selection: FacetSelection
  readonly onToggle: (key: FacetKey, value: string) => void
}): JSX.Element | null {
  const t = useUiText()
  const [open, setOpen] = useState<FacetKey | null>(null)
  const [showAll, setShowAll] = useState<ReadonlySet<FacetKey>>(new Set())
  const views = facetViews(facets, {
    location: t('uiLibrary.deviceValuePicker.facetLocation', 'Location'),
    integration: t('uiLibrary.deviceValuePicker.facetIntegration', 'Integration'),
    type: t('uiLibrary.deviceValuePicker.facetType', 'Type'),
  }).filter((v) => v.options.length > 1 || selection[v.key].length > 0)
  if (views.length === 0) return null
  const any = t('uiLibrary.deviceValuePicker.facetAny', 'any')
  const providers = useIntegrationProviders(open === 'integrationIds')
  const detailOf = (key: FacetKey, value: string): string | undefined =>
    key === 'integrationIds' ? providers.get(value) : undefined

  return (
    <nav
      aria-label={t('uiLibrary.deviceValuePicker.filters', 'Filters')}
      className="flex shrink-0 flex-col gap-0.5 border-b border-border p-2 text-xs sm:w-52 sm:border-b-0 sm:border-r"
    >
      {views.map((view) => {
        const isOpen = open === view.key
        const labelOf = (value: string) =>
          view.options.find((o) => o.value === value)?.label ?? value
        const { shown, more } = topFacetOptions(view.options, FACET_TOP, showAll.has(view.key))
        return (
          <div key={view.key}>
            <Button
              variant="unstyled"
              type="button"
              aria-expanded={isOpen}
              className="flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-left font-medium text-foreground hover:bg-surface-hover"
              onClick={() => setOpen(isOpen ? null : view.key)}
            >
              <ChevronRight className={cn('h-3 w-3 shrink-0', isOpen && 'rotate-90')} />
              <span>{view.name}</span>
              <span className="ml-auto min-w-0 truncate text-[11px] font-normal text-primary">
                {facetSummary(selection[view.key], any, labelOf)}
              </span>
            </Button>
            {isOpen && (
              <div className="flex flex-col pb-1 pl-3">
                {shown.map((opt) => {
                  const detail = detailOf(view.key, opt.value)
                  return (
                    <label
                      key={opt.value}
                      title={detail === undefined ? opt.label : `${opt.label} · ${detail}`}
                      className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-foreground hover:bg-surface-hover"
                    >
                      <Checkbox
                        checked={selection[view.key].includes(opt.value)}
                        onChange={() => onToggle(view.key, opt.value)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{opt.label}</span>
                        {detail !== undefined && (
                          <span
                            className="truncate text-[11px] text-foreground-muted"
                            data-testid="dvp-facet-provider"
                          >
                            {detail}
                          </span>
                        )}
                      </span>
                      <span className="text-foreground-subtle">{opt.count}</span>
                    </label>
                  )
                })}
                {more > 0 && (
                  <Button
                    variant="unstyled"
                    type="button"
                    className="px-1.5 py-1 text-left text-[11px] text-primary hover:underline"
                    onClick={() => setShowAll((prev) => new Set([...prev, view.key]))}
                  >
                    {t('uiLibrary.deviceValuePicker.facetMore', '{{count}} more', { count: more })}
                  </Button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}
