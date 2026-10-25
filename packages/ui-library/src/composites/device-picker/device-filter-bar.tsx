/**
 * The filter bar above a picker's list (D697): search, "Group by" (when the
 * list offers it), the Type / Zone / Location dropdowns and "Reset filters".
 *
 * It owns no filter state — the caller holds `PickerFilters` and applies them
 * (`applyPickerFilters`); this only draws the controls and reports changes.
 * The search box keeps its own text so typing is instant, and tells the
 * caller `PICKER_SEARCH_DEBOUNCE_MS` after the last keystroke.
 *
 * The Zone and Location dropdowns are provisional (operator answer Q1): to
 * drop them, delete the two `FacetDropdown` uses in {@link DeviceFilterBar}
 * and their option props — the model side is described in
 * `device-picker-model.ts`.
 *
 *  - D315: a zones read that has not answered draws the Zone dropdown
 *    DISABLED ("loading zones…" / "zones unavailable"), never empty, and a
 *    chosen zone is reported as paused, not as matching nothing.
 *  - "Reset filters" clears search, Type, Zone and Location and leaves the
 *    Group-by choice alone.
 */

import { Button, Checkbox } from '../../primitives/index.js'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover.js'
import { Search } from 'lucide-react'
import { useEffect, useRef, useState, type JSX } from 'react'
import { defaultUiText, useUiText, type UiTextFn } from '../../contexts/ui-text'
import { INPUT_SHELL } from './SelectedChip.js'
import {
  PICKER_GROUP_BY_MODES,
  PICKER_NONE_KEY,
  PICKER_SEARCH_DEBOUNCE_MS,
  type PickerFacet,
  type PickerFacetOption,
  type PickerFilters,
  type PickerGroupBy,
  type PickerZonesFallback,
  type PickerZonesRead,
  pickerFacetFilterShown,
  pickerFiltersActive,
  pickerZoneFilterSuspended,
  resetPickerFilters,
  togglePickerKey,
} from './device-picker-model'

/** The Group-by control's inputs, as `DevicePicker.tsx` passes them. */
export interface DeviceFilterBarGrouping {
  readonly groupBy: PickerGroupBy
  readonly onGroupByChange: (next: PickerGroupBy) => void
  /** Set when Zone mode is showing locations because the zones had not answered. */
  readonly fallback: PickerZonesFallback | null
}

export interface DeviceFilterBarProps {
  readonly filters: PickerFilters
  readonly onFiltersChange: (next: PickerFilters) => void
  readonly typeOptions: readonly PickerFacetOption[]
  readonly zoneOptions: readonly PickerFacetOption[]
  readonly locationOptions: readonly PickerFacetOption[]
  /** The zones read — decides whether the Zone dropdown is enabled and what it says. */
  readonly zones: PickerZonesRead
  /** Group by, when the list offers it (the device picker and the alarm table do). */
  readonly grouping?: DeviceFilterBarGrouping
  readonly searchPlaceholder: string
  readonly searchLabel: string
  readonly disabled?: boolean
}

/** "media-player" → "Media player"; null → "No type". */
export function typeLabel(type: string | null, t: UiTextFn = defaultUiText): string {
  if (type === null) return t('uiLibrary.deviceFilterBar.noType', 'No type')
  const spaced = type.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function groupByLabel(mode: PickerGroupBy, t: UiTextFn): string {
  switch (mode) {
    case 'zone':
      return t('uiLibrary.deviceFilterBar.zone', 'Zone')
    case 'location':
      return t('uiLibrary.deviceFilterBar.location', 'Location')
    case 'none':
      return t('uiLibrary.deviceFilterBar.none', 'None')
  }
}

function facetTitle(facet: PickerFacet, t: UiTextFn): string {
  switch (facet) {
    case 'type':
      return t('uiLibrary.deviceFilterBar.type', 'Type')
    case 'zone':
      return t('uiLibrary.deviceFilterBar.zone', 'Zone')
    case 'location':
      return t('uiLibrary.deviceFilterBar.location', 'Location')
  }
}

function noValueLabel(facet: PickerFacet, t: UiTextFn): string {
  switch (facet) {
    case 'type':
      return t('uiLibrary.deviceFilterBar.noType', 'No type')
    case 'zone':
      return t('uiLibrary.deviceFilterBar.noZone', 'No zone')
    case 'location':
      return t('uiLibrary.deviceFilterBar.noLocation', 'No location')
  }
}

function optionLabel(facet: PickerFacet, option: PickerFacetOption, t: UiTextFn): string {
  if (option.key === PICKER_NONE_KEY || option.label === null) return noValueLabel(facet, t)
  return facet === 'type' ? typeLabel(option.label, t) : option.label
}

interface GroupByControlProps {
  readonly grouping: DeviceFilterBarGrouping
}

/** "Group by: Zone | Location | None", and why Zone is showing locations. */
function GroupByControl({ grouping }: GroupByControlProps) {
  const t = useUiText()
  return (
    <div className="mb-1.5">
      <div
        role="radiogroup"
        aria-label={t('uiLibrary.deviceFilterBar.groupBy', 'Group by')}
        className="flex flex-wrap items-center gap-1 text-[10px] text-foreground-subtle"
      >
        <span className="mr-1 font-semibold uppercase tracking-wide">
          {t('uiLibrary.deviceFilterBar.groupBy', 'Group by')}
        </span>
        {PICKER_GROUP_BY_MODES.map((mode) => {
          const active = mode === grouping.groupBy
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => grouping.onGroupByChange(mode)}
              className={
                active
                  ? 'rounded-md border border-primary bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary'
                  : 'rounded-md border border-border px-1.5 py-0.5 text-[11px] text-foreground-subtle hover:bg-surface-hover'
              }
            >
              {groupByLabel(mode, t)}
            </button>
          )
        })}
      </div>
      {grouping.fallback !== null && (
        <p className="mt-0.5 text-[10px] text-foreground-subtle" data-testid="picker-zones-note">
          {grouping.fallback === 'pending'
            ? t(
                'uiLibrary.deviceFilterBar.zonesLoadingNote',
                'Loading zones — grouped by location for now',
              )
            : t(
                'uiLibrary.deviceFilterBar.zonesUnavailableNote',
                'Zones unavailable — grouped by location',
              )}
        </p>
      )}
    </div>
  )
}

interface FacetDropdownProps {
  readonly facet: PickerFacet
  readonly options: readonly PickerFacetOption[]
  readonly chosen: readonly string[]
  readonly onChange: (next: string[]) => void
  /** Why the dropdown cannot be used (the zones read), shown as its trigger text. */
  readonly unavailable?: string
  readonly disabled: boolean
}

function FacetDropdown({
  facet,
  options,
  chosen,
  onChange,
  unavailable,
  disabled,
}: FacetDropdownProps) {
  const t = useUiText()
  const title = facetTitle(facet, t)
  const summary =
    unavailable !== undefined
      ? unavailable
      : chosen.length === 0
        ? t('uiLibrary.deviceFilterBar.all', 'All')
        : t('uiLibrary.deviceFilterBar.nSelected', '{{count}} selected', { count: chosen.length })
  return (
    <div data-testid={`picker-filter-${facet}`}>
      <Popover>
        <PopoverTrigger
          disabled={disabled || unavailable !== undefined}
          className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-surface-hover disabled:opacity-50"
        >
          {title}: {summary}
        </PopoverTrigger>
        <PopoverContent className="min-w-[200px] max-h-[40vh] overflow-y-auto p-1">
          {options.map((option) => {
            const label = optionLabel(facet, option, t)
            return (
              <label
                key={option.key}
                className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs text-foreground hover:bg-surface-hover"
              >
                <Checkbox
                  checked={chosen.includes(option.key)}
                  onChange={() => onChange(togglePickerKey(chosen, option.key))}
                  aria-label={label}
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="text-[10px] text-foreground-subtle">({option.count})</span>
              </label>
            )
          })}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** Why the Zone dropdown cannot be used, or undefined when the read answered. */
function zoneUnavailable(zones: PickerZonesRead, t: UiTextFn): string | undefined {
  if (zones.state === 'pending')
    return t('uiLibrary.deviceFilterBar.loadingZones', 'loading zones…')
  if (zones.state === 'failed')
    return t('uiLibrary.deviceFilterBar.zonesUnavailable', 'zones unavailable')
  return undefined
}

export function DeviceFilterBar({
  filters,
  onFiltersChange,
  typeOptions,
  zoneOptions,
  locationOptions,
  zones,
  grouping,
  searchPlaceholder,
  searchLabel,
  disabled = false,
}: DeviceFilterBarProps): JSX.Element {
  const t = useUiText()
  const [text, setText] = useState(filters.query)
  // The latest filters, for the debounce timer: it fires after other facets may have changed.
  const latest = useRef({ filters, onFiltersChange })
  latest.current = { filters, onFiltersChange }

  useEffect(() => {
    if (text === latest.current.filters.query) return
    const timer = setTimeout(
      () => latest.current.onFiltersChange({ ...latest.current.filters, query: text }),
      PICKER_SEARCH_DEBOUNCE_MS,
    )
    return () => clearTimeout(timer)
  }, [text])

  const unavailable = zoneUnavailable(zones, t)
  const zoneShown = unavailable !== undefined || pickerFacetFilterShown(zoneOptions, filters.zones)
  const active = pickerFiltersActive(filters) || text.trim() !== ''

  return (
    <div className="space-y-1.5" data-testid="device-filter-bar">
      {grouping !== undefined && <GroupByControl grouping={grouping} />}
      <div className={INPUT_SHELL}>
        <Search className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
        <input
          type="text"
          value={text}
          placeholder={searchPlaceholder}
          aria-label={searchLabel}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground-disabled"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {pickerFacetFilterShown(typeOptions, filters.types) && (
          <FacetDropdown
            facet="type"
            options={typeOptions}
            chosen={filters.types}
            onChange={(types) => onFiltersChange({ ...filters, types })}
            disabled={disabled}
          />
        )}
        {zoneShown && (
          <FacetDropdown
            facet="zone"
            options={zoneOptions}
            chosen={filters.zones}
            onChange={(next) => onFiltersChange({ ...filters, zones: next })}
            {...(unavailable !== undefined ? { unavailable } : {})}
            disabled={disabled}
          />
        )}
        {pickerFacetFilterShown(locationOptions, filters.locations) && (
          <FacetDropdown
            facet="location"
            options={locationOptions}
            chosen={filters.locations}
            onChange={(locations) => onFiltersChange({ ...filters, locations })}
            disabled={disabled}
          />
        )}
        {active && (
          <Button
            variant="ghost"
            data-testid="picker-reset-filters"
            onClick={() => {
              setText('')
              onFiltersChange(resetPickerFilters())
            }}
          >
            {t('uiLibrary.deviceFilterBar.resetFilters', 'Reset filters')}
          </Button>
        )}
      </div>
      {pickerZoneFilterSuspended(filters, zones) && (
        <p className="text-[10px] text-foreground-subtle" data-testid="picker-zone-filter-paused">
          {t('uiLibrary.deviceFilterBar.zoneFilterPaused', 'Zone filter paused — zones not loaded')}
        </p>
      )}
    </div>
  )
}
