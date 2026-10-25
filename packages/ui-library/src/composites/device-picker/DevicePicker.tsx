/**
 * The smart device picker every notification editor uses: the selection as
 * compact chips, and a searchable, grouped list opened only to change it.
 *
 * It replaces the long checklists (a rule's devices, a system rule's
 * include/exclude, the timelapse and digest cameras, the alarm's non-blocking
 * openings) with the same UX the viewer's picker has (D636). The decisions are
 * `device-picker-model.ts` (shared with the viewer, byte-identical); what a
 * selected id the list does not draw IS — removed, named, or unknown — is
 * `device-selection.ts`, and so are the two rules that shaped it:
 *
 *  - D315: only a list that ANSWERED may call an id removed or say "no
 *    cameras"; a pending list is a loading line and names nothing absent.
 *  - D49: a read never drops a selected id; every one is a chip the operator
 *    can remove, and only the operator removes one.
 *
 * It reads nothing. It filters the list its caller already holds, and judges
 * an off-list id against the caller's fleet (a camera picker draws cameras,
 * and a selected sensor missing from it still exists).
 *
 * Generic over the id since D637: the system family's node and package pickers
 * (`scope-pickers.tsx`) are this picker over string ids, with their own noun
 * and group titles.
 *
 * Bounded at hundreds of devices of one type: big groups start collapsed, the
 * rows are rendered a page at a time with "Show N more", and the chips stop at
 * `PICKER_CHIP_LIMIT` with a "+N more". `showAll` turns all three off, and the
 * list is always open: the rule editor's Devices tab exists to show every
 * device (R15, D690).
 *
 * "Group by" (Zone | Location | None) sits at the top of a DEVICE picker's
 * list only — the node and package pickers keep their own groups, and so does
 * the CLASS picker (D641), whose groups are the taxonomy's categories. The choice
 * is remembered in `localStorage`, and the site zones are read whenever the
 * panel is open (the Zone filter needs them; `device-picker-grouping.ts`); a zone read that has
 * not answered groups by location with a one-line note, never "No zone"
 * (D315).
 */

import { useId, useMemo, useState, type JSX } from 'react'
import { defaultUiText, useUiText, type UiTextFn } from '../../contexts/ui-text'
import { SelectedChip } from './SelectedChip.js'
import { DeviceFilterBar, typeLabel } from './device-filter-bar'
import type { PickerFleetView } from './device-fleet-view'
import { withResolvedParentDetail } from './device-parent.js'
import { usePickerSiteZones, useStoredGroupBy } from './device-picker-grouping'
import {
  applyPickerFilters,
  chipOverflow,
  clearPickerGroup,
  flattenPickerGrouping,
  flattenPickerRows,
  groupPickerDevices,
  groupPickerDevicesBy,
  PICKER_CHIP_LIMIT,
  PICKER_NO_FILTERS,
  PICKER_PAGE_SIZE,
  type PickerFilters,
  type PickerGroup,
  type PickerGroupBy,
  type PickerGroupHeading,
  type PickerId,
  type PickerItem,
  type PickerRow,
  type PickerZonesRead,
  pageRows,
  pickerFacetOptions,
  pickerHiddenSelectedCount,
  pickerQueryTokens,
  pickerRowFacts,
  selectPickerGroup,
  togglePickerDevice,
} from './device-picker-model'
import {
  type DeviceListState,
  emptyDevicesWidens,
  offListSelections,
  type SelectedDeviceRow,
  showsNoCamerasHint,
} from './device-selection'
import {
  DevicesFailedLine,
  DevicesLoadingLine,
  DevicesWidenWarning,
  orphanDeviceLabel,
  pickerNounLabel,
  pickerNounPluralLabel,
  PICKER_NOUN_PLURAL,
  type PickerNoun,
} from './device-selection-rows'

/** One device, or the checklist every rule editor uses. */
export type DevicePickerSelection = 'single' | 'multiple'

export interface DevicePickerProps<Id extends PickerId = number> {
  /** The devices the list DRAWS — the caller's answered list, `[]` otherwise. */
  readonly devices: readonly PickerItem<Id>[]
  /** Whether `devices` ANSWERED (D315). */
  readonly listState: DeviceListState
  /** What an off-list selected id is judged against. Defaults to the list. */
  readonly fleet?: PickerFleetView<Id>
  readonly value: readonly Id[]
  readonly onChange: (next: Id[]) => void
  /**
   * `single`: one radio, no All/Clear, no "N selected". Choosing a row
   * replaces `value` with that id. Default is the checklist.
   */
  readonly selection?: DevicePickerSelection
  /**
   * Group this list by zone, location or none. Absent uses the remembered
   * choice. A value here does not change that choice.
   */
  readonly groupBy?: PickerGroupBy
  /** Empty selection means EVERY device: say so, and warn when it widens. */
  readonly emptyMeansAll?: boolean
  /** Whether the saved rule had devices — the widening warning survives a remount. */
  readonly savedHadDevices?: boolean
  /** What the list holds, for its sentences. */
  readonly noun?: PickerNoun
  /** A group header's title. Defaults to "<type> · <room>". */
  readonly groupTitle?: (group: PickerGroup<Id>) => string
  /** What an empty selection reads as, when it does not mean "every device". */
  readonly emptyLabel?: string
  /** A per-device note drawn beside the name (the alarm's "not covered"). */
  readonly annotate?: (id: Id) => string | undefined
  readonly disabled?: boolean
  readonly testId?: string
  /**
   * List EVERYTHING, always open: no Edit/Done toggle, no "+N more" chips, no
   * "Show N more" rows, every group open until the operator folds one. For a
   * surface whose whole job is the list — the rule's Devices tab (R15).
   */
  readonly showAll?: boolean
  /**
   * Devices that are ALREADY part of the thing being edited (linked to the
   * camera, assigned to the room): drawn checked and disabled with
   * `lockedNote`, never part of `value`, never emitted by `onChange`.
   */
  readonly lockedIds?: readonly Id[]
  /** The line under a locked device. Default "Already added". */
  readonly lockedNote?: string
}

/** A "Group by" group's title: the zone or room, or which one it lacks. */
function headingTitle(heading: PickerGroupHeading, t: UiTextFn): string {
  switch (heading.kind) {
    case 'zone':
    case 'location':
      return heading.label
    case 'no-zone':
      return t('uiLibrary.devicePicker.noZone', 'No zone')
    case 'no-location':
      return t('uiLibrary.devicePicker.noLocation', 'No location')
  }
}

function deviceGroupTitle<Id extends PickerId>(
  group: PickerGroup<Id>,
  t: UiTextFn = defaultUiText,
): string {
  if (group.heading !== undefined) return headingTitle(group.heading, t)
  return `${typeLabel(group.type, t)} · ${group.location ?? t('uiLibrary.devicePicker.noRoom', 'No room')}`
}

/** The device picker's "Group by": the chosen mode, how to change it, and the zone read. */
interface PickerGroupingControl {
  readonly groupBy: PickerGroupBy
  readonly onGroupByChange: (next: PickerGroupBy) => void
  readonly zones: PickerZonesRead
}

/** Whether a picker lists devices — the only kind with "Group by". */
function isDeviceNoun(noun: PickerNoun): boolean {
  return noun === 'camera' || noun === 'device'
}

/** One selected id as a chip: its name, or what `device-selection` says about it. */
interface PickerChip<Id extends PickerId> {
  readonly id: Id
  readonly label: string
  readonly removed: boolean
}

function chipsOf<Id extends PickerId>(
  value: readonly Id[],
  devices: readonly PickerItem<Id>[],
  fleet: PickerFleetView<Id>,
  noun: PickerNoun,
  t: UiTextFn,
): readonly PickerChip<Id>[] {
  const byId = new Map<Id, string>(devices.map((device) => [device.id, device.name]))
  const orphans = new Map<Id, SelectedDeviceRow<Id>>(
    offListSelections(value, devices, fleet.devices, fleet.state).map((row) => [row.id, row]),
  )
  return value.map((id) => {
    const name = byId.get(id)
    if (name !== undefined) return { id, label: name, removed: false }
    const row = orphans.get(id) ?? { id, removed: false }
    return { id, label: orphanDeviceLabel(row, noun, t), removed: row.removed }
  })
}

/** The empty-list sentence: the device pickers keep the words they shipped with. */
function noItemsSentence(noun: PickerNoun, emptyMeansAll: boolean, t: UiTextFn): string {
  const plural = pickerNounPluralLabel(noun, t)
  if (!emptyMeansAll) {
    return t('uiLibrary.devicePicker.noneAvailable', 'No {{plural}} available.', { plural })
  }
  if (noun === 'camera' || noun === 'device') {
    return t(
      'uiLibrary.devicePicker.noCamerasAvailable',
      'No cameras available — the rule applies to all devices.',
    )
  }
  return t(
    'uiLibrary.devicePicker.noneAvailableAll',
    'No {{plural}} available — the rule applies to every {{noun}}.',
    { plural, noun: pickerNounLabel(noun, t) },
  )
}

export function DevicePicker<Id extends PickerId = number>({
  devices: devicesIn,
  listState,
  fleet,
  value,
  onChange,
  selection = 'multiple',
  groupBy: pinnedGroupBy,
  emptyMeansAll = false,
  savedHadDevices = false,
  noun = 'camera',
  groupTitle: groupTitleProp,
  emptyLabel,
  annotate,
  disabled = false,
  testId,
  showAll = false,
  lockedIds,
  lockedNote: lockedNoteProp,
}: DevicePickerProps<Id>): JSX.Element {
  const t = useUiText()
  const groupTitle = groupTitleProp ?? ((group: PickerGroup<Id>) => deviceGroupTitle(group, t))
  const lockedNote = lockedNoteProp ?? t('uiLibrary.devicePicker.alreadyAdded', 'Already added')
  // Container/hub children get a second line (`in <parent>`) from the same
  // listing — `parentDeviceId` is already on the slim projection.
  const devices = useMemo(() => withResolvedParentDetail(devicesIn), [devicesIn])
  const judge: PickerFleetView<Id> = fleet ?? {
    state: listState,
    devices: listState === 'answered' ? devices : undefined,
  }
  const locked = useMemo<ReadonlySet<Id>>(() => new Set(lockedIds ?? []), [lockedIds])
  // A group's "All" would select a locked device too: it is already in, so it is never emitted.
  const emit = (next: Id[]): void =>
    onChange(locked.size === 0 ? next : next.filter((id) => !locked.has(id)))
  const [open, setOpen] = useState(false)
  const [chipsExpanded, setChipsExpanded] = useState(false)
  const [hadDevices, setHadDevices] = useState(savedHadDevices || value.length > 0)
  if (value.length > 0 && !hadDevices) setHadDevices(true)

  const chips = chipsOf(value, devices, judge, noun, t)
  const overflow = chipOverflow(chips, chipsExpanded || showAll)
  const listOpen = open || showAll
  const widening = emptyDevicesWidens(emptyMeansAll, value.length, hadDevices)
  const plural = PICKER_NOUN_PLURAL[noun]

  if (listState === 'answered' && showsNoCamerasHint(listState, devices.length, value.length)) {
    return (
      <div data-testid={testId}>
        <p className="text-[10px] text-foreground-subtle mt-0.5">
          {noItemsSentence(noun, emptyMeansAll, t)}
        </p>
        {widening && <DevicesWidenWarning noun={noun} />}
      </div>
    )
  }

  return (
    <div className="mt-1 space-y-1.5" data-testid={testId}>
      {listState === 'pending' && <DevicesLoadingLine noun={plural} />}
      {listState === 'failed' && (
        <DevicesFailedLine noun={noun === 'camera' ? 'devices' : plural} />
      )}
      {!(selection === 'single' && chips.length === 0) && (
        <div className="flex flex-wrap items-center gap-1">
          {chips.length === 0 ? (
            <span className="text-[11px] text-foreground-subtle">
              {emptyLabel ??
                (emptyMeansAll
                  ? t(
                      'uiLibrary.devicePicker.everyNoRestriction',
                      'Every {{noun}} — no restriction',
                      {
                        noun: pickerNounLabel(noun, t),
                      },
                    )
                  : t('uiLibrary.devicePicker.noneSelected', 'None selected'))}
            </span>
          ) : (
            overflow.shown.map((chip) => (
              <SelectedChip
                key={chip.id}
                testId={`picker-chip-${String(chip.id)}`}
                label={chip.label}
                warning={chip.removed}
                {...(!disabled
                  ? { onRemove: () => onChange(value.filter((id) => id !== chip.id)) }
                  : {})}
              />
            ))
          )}
          {overflow.hidden > 0 && (
            <button
              type="button"
              className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-foreground-subtle hover:bg-surface-hover"
              onClick={() => setChipsExpanded(true)}
            >
              {t('uiLibrary.devicePicker.moreChips', '+{{count}} more', { count: overflow.hidden })}
            </button>
          )}
          {chipsExpanded && chips.length > PICKER_CHIP_LIMIT && (
            <button
              type="button"
              className="text-[11px] text-foreground-subtle underline"
              onClick={() => setChipsExpanded(false)}
            >
              {t('uiLibrary.devicePicker.showFewer', 'Show fewer')}
            </button>
          )}
          {listState !== 'pending' && !showAll && (
            <button
              type="button"
              disabled={disabled}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-surface-hover disabled:opacity-50"
            >
              {open
                ? t('uiLibrary.devicePicker.done', 'Done')
                : value.length === 0
                  ? t('uiLibrary.devicePicker.addPlural', 'Add {{plural}}…', {
                      plural: pickerNounPluralLabel(noun, t),
                    })
                  : t('uiLibrary.devicePicker.edit', 'Edit…')}
            </button>
          )}
        </div>
      )}
      {listOpen &&
        listState === 'answered' &&
        (isDeviceNoun(noun) ? (
          <GroupedPickerPanel
            devices={devices}
            value={value}
            onChange={emit}
            locked={locked}
            lockedNote={lockedNote}
            annotate={annotate}
            groupTitle={groupTitle}
            noun={noun}
            disabled={disabled}
            showAll={showAll}
            selection={selection}
            {...(pinnedGroupBy !== undefined ? { pinnedGroupBy } : {})}
          />
        ) : (
          <PickerPanel
            devices={devices}
            value={value}
            onChange={emit}
            locked={locked}
            lockedNote={lockedNote}
            annotate={annotate}
            groupTitle={groupTitle}
            noun={noun}
            disabled={disabled}
            showAll={showAll}
            selection={selection}
          />
        ))}
      {widening && <DevicesWidenWarning noun={noun} />}
    </div>
  )
}

interface PickerPanelProps<Id extends PickerId> {
  readonly devices: readonly PickerItem<Id>[]
  readonly value: readonly Id[]
  readonly onChange: (next: Id[]) => void
  readonly annotate: ((id: Id) => string | undefined) | undefined
  readonly groupTitle: (group: PickerGroup<Id>) => string
  readonly noun: PickerNoun
  readonly disabled: boolean
  readonly locked: ReadonlySet<Id>
  readonly lockedNote: string
  /** Every row, every group open by default — see `DevicePickerProps.showAll`. */
  readonly showAll: boolean
  readonly selection: DevicePickerSelection
  /** This instance's group-by. Absent: the remembered choice. */
  readonly pinnedGroupBy?: PickerGroupBy
  /** "Group by" — the device picker only; absent keeps the (type, room) groups. */
  readonly grouping?: PickerGroupingControl
}

/**
 * The device picker's panel: mounted only while the list is open, so the zone
 * read below happens only then (for Zone grouping and the Zone filter).
 */
function GroupedPickerPanel<Id extends PickerId>(props: PickerPanelProps<Id>) {
  const stored = useStoredGroupBy()
  const [localGroupBy, setLocalGroupBy] = useState<PickerGroupBy | null>(null)
  const pinned = props.pinnedGroupBy
  const groupBy = pinned !== undefined ? (localGroupBy ?? pinned) : stored.groupBy
  const onGroupByChange = (next: PickerGroupBy): void => {
    if (pinned !== undefined) {
      setLocalGroupBy(next)
      return
    }
    stored.setGroupBy(next)
  }
  // Asked whenever the panel is open: the Zone filter needs the read as much as Zone grouping.
  const zones = usePickerSiteZones(true)
  return <PickerPanel {...props} grouping={{ groupBy, onGroupByChange, zones }} />
}

/** The search box's hint: a device has a room and a type, a class a category, a node or package an id. */
function searchPlaceholder(noun: PickerNoun, t: UiTextFn): string {
  if (noun === 'camera' || noun === 'device') {
    return t('uiLibrary.devicePicker.searchDevice', 'Search by name, room or type…')
  }
  if (noun === 'class') {
    return t('uiLibrary.devicePicker.searchClass', 'Search by class or category…')
  }
  if (noun === 'zone') {
    return t('uiLibrary.devicePicker.searchZone', 'Search by camera or zone…')
  }
  return t('uiLibrary.devicePicker.searchDefault', 'Search by name or id…')
}

/** An answered read with no zones: what the pickers without "Group by" are judged against. */
const NO_ZONES: PickerZonesRead = { state: 'answered', zones: [] }

/** The searchable, grouped list — rendered one page at a time. */
function PickerPanel<Id extends PickerId>({
  devices,
  value,
  onChange,
  annotate,
  groupTitle,
  noun,
  disabled,
  locked,
  lockedNote,
  showAll,
  selection,
  grouping,
}: PickerPanelProps<Id>) {
  const t = useUiText()
  const radioName = useId()
  const [filters, setFilters] = useState<PickerFilters>(PICKER_NO_FILTERS)
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [shown, setShown] = useState(PICKER_PAGE_SIZE)
  // Under `showAll` every group opens as a search result would — the
  // operator's own fold still wins (`isGroupExpanded`).
  const searching = showAll || pickerQueryTokens(filters.query).length > 0
  const groupBy = grouping?.groupBy
  // The node and package pickers have no zones, and their `location` is a
  // liveness, not a place: they are judged against an answered, empty read so
  // Zone and Location draw nothing for them.
  const zones: PickerZonesRead = grouping?.zones ?? NO_ZONES
  const matches = useMemo(
    () => applyPickerFilters(devices, filters, zones),
    [devices, filters, zones],
  )
  const grouped = useMemo(
    () => (groupBy !== undefined ? groupPickerDevicesBy(matches, value, groupBy, zones) : null),
    [matches, value, groupBy, zones],
  )
  const rows = useMemo(
    () =>
      grouped !== null
        ? flattenPickerGrouping(grouped, value, toggles, searching)
        : flattenPickerRows(groupPickerDevices(matches, value), value, toggles, searching),
    [grouped, matches, value, toggles, searching],
  )
  const shownBy = grouped?.groupBy ?? null
  const typeOptions = useMemo(
    () => pickerFacetOptions(devices, 'type', filters.types, zones),
    [devices, filters.types, zones],
  )
  const zoneOptions = useMemo(
    () => pickerFacetOptions(devices, 'zone', filters.zones, zones),
    [devices, filters.zones, zones],
  )
  const locationOptions = useMemo(
    () =>
      grouping === undefined
        ? []
        : pickerFacetOptions(devices, 'location', filters.locations, zones),
    [devices, filters.locations, zones, grouping],
  )
  const hiddenSelected = useMemo(
    () => pickerHiddenSelectedCount(value, devices, matches),
    [devices, value, matches],
  )
  const page = pageRows(rows, showAll ? rows.length : shown)
  const toggleGroup = (group: PickerGroup<Id>, expanded: boolean): void =>
    setToggles((current) => new Map([...current, [group.key, !expanded]]))

  return (
    <div
      className="rounded-md border border-border bg-surface p-2"
      data-testid="device-picker-panel"
    >
      <DeviceFilterBar
        filters={filters}
        onFiltersChange={(next) => {
          setFilters(next)
          setShown(PICKER_PAGE_SIZE)
        }}
        typeOptions={typeOptions}
        zoneOptions={zoneOptions}
        locationOptions={locationOptions}
        zones={zones}
        {...(grouping !== undefined
          ? {
              grouping: {
                groupBy: grouping.groupBy,
                onGroupByChange: grouping.onGroupByChange,
                fallback: grouped?.fallback ?? null,
              },
            }
          : {})}
        searchPlaceholder={searchPlaceholder(noun, t)}
        searchLabel={
          noun === 'camera' || noun === 'device'
            ? t('uiLibrary.devicePicker.searchDevices', 'Search devices')
            : t('uiLibrary.devicePicker.searchPlural', 'Search {{plural}}', {
                plural: pickerNounPluralLabel(noun, t),
              })
        }
        disabled={disabled}
      />
      <p className="mt-1 text-[10px] text-foreground-subtle">
        {selection === 'single'
          ? t('uiLibrary.devicePicker.shownOfSingle', '{{shown}} of {{total}} shown', {
              shown: matches.length,
              total: devices.length,
            })
          : t(
              'uiLibrary.devicePicker.shownOf',
              '{{shown}} of {{total}} shown · {{selected}} selected',
              {
                shown: matches.length,
                total: devices.length,
                selected: value.length,
              },
            )}
      </p>
      {rows.length === 0 ? (
        <p className="py-2 text-[11px] text-foreground-subtle italic">
          {noun === 'camera' || noun === 'device'
            ? t('uiLibrary.devicePicker.noDeviceMatches', 'No device matches.')
            : t('uiLibrary.devicePicker.noNounMatches', 'No {{noun}} matches.', {
                noun: pickerNounLabel(noun, t),
              })}
        </p>
      ) : (
        <div
          className={showAll ? 'mt-1' : 'mt-1 max-h-72 overflow-y-auto'}
          data-testid="device-picker-rows"
        >
          {page.rows.map((row) => (
            <PickerRowView
              key={row.key}
              row={row}
              value={value}
              onChange={onChange}
              onToggleGroup={toggleGroup}
              annotate={annotate}
              groupTitle={groupTitle}
              groupBy={shownBy}
              disabled={disabled}
              locked={locked}
              lockedNote={lockedNote}
              selection={selection}
              radioName={radioName}
            />
          ))}
          {page.remaining > 0 && (
            <button
              type="button"
              className="mt-1 w-full rounded border border-border py-1 text-[11px] text-foreground-subtle hover:bg-surface-hover"
              onClick={() => setShown((n) => n + PICKER_PAGE_SIZE)}
            >
              {t('uiLibrary.devicePicker.showMore', 'Show {{count}} more ({{left}} left)', {
                count: Math.min(page.remaining, PICKER_PAGE_SIZE),
                left: page.remaining,
              })}
            </button>
          )}
        </div>
      )}
      {hiddenSelected > 0 && (
        <p className="mt-1 text-[10px] text-foreground-subtle" data-testid="picker-hidden-selected">
          {t('uiLibrary.devicePicker.hiddenSelected', '{{count}} selected hidden by filters', {
            count: hiddenSelected,
          })}
        </p>
      )}
    </div>
  )
}

interface PickerRowViewProps<Id extends PickerId> {
  readonly row: PickerRow<Id>
  readonly value: readonly Id[]
  readonly onChange: (next: Id[]) => void
  readonly onToggleGroup: (group: PickerGroup<Id>, expanded: boolean) => void
  readonly annotate: ((id: Id) => string | undefined) | undefined
  readonly groupTitle: (group: PickerGroup<Id>) => string
  /** The "Group by" mode the list is drawn in; null for (type, room) groups. */
  readonly groupBy: PickerGroupBy | null
  readonly disabled: boolean
  readonly locked: ReadonlySet<Id>
  readonly lockedNote: string
  readonly selection: DevicePickerSelection
  readonly radioName: string
}

/** The second line: under "Group by" the room (where the header lacks it) and type, then the container. */
function secondLine<Id extends PickerId>(
  device: PickerItem<Id>,
  groupBy: PickerGroupBy | null,
): string | undefined {
  if (groupBy === null) return device.detail
  const facts = pickerRowFacts(device, groupBy)
  const parts = [
    facts.location,
    facts.type === null ? null : typeLabel(facts.type),
    device.detail ?? null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function PickerRowView<Id extends PickerId>({
  row,
  value,
  onChange,
  onToggleGroup,
  annotate,
  groupTitle,
  groupBy,
  disabled,
  locked,
  lockedNote,
  selection,
  radioName,
}: PickerRowViewProps<Id>) {
  const t = useUiText()
  const single = selection === 'single'
  if (row.kind === 'header') {
    const { group, expanded } = row
    return (
      <div
        className="flex items-center gap-2 border-b border-border px-1 py-1"
        data-testid="device-picker-group"
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onToggleGroup(group, expanded)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle"
        >
          <span>{expanded ? '▾' : '▸'}</span>
          <span className="truncate">{groupTitle(group)}</span>
          {!single && (
            <span className="font-normal normal-case">
              ({group.selectedCount}/{group.devices.length})
            </span>
          )}
        </button>
        {!single && (
          <button
            type="button"
            disabled={disabled}
            className="text-[10px] text-primary hover:underline disabled:opacity-50"
            onClick={() => onChange(selectPickerGroup(value, group))}
          >
            {t('uiLibrary.devicePicker.all', 'All')}
          </button>
        )}
        {!single && (
          <button
            type="button"
            disabled={disabled}
            className="text-[10px] text-foreground-subtle hover:underline disabled:opacity-50"
            onClick={() => onChange(clearPickerGroup(value, group))}
          >
            {t('uiLibrary.devicePicker.clear', 'Clear')}
          </button>
        )}
      </div>
    )
  }
  const isLocked = locked.has(row.device.id)
  const note = isLocked ? lockedNote : annotate?.(row.device.id)
  const second = secondLine(row.device, groupBy)
  return (
    <label
      className="flex cursor-pointer items-center gap-2.5 px-3 py-1 text-xs text-foreground hover:bg-surface-hover"
      data-testid="device-picker-row"
    >
      <input
        type={single ? 'radio' : 'checkbox'}
        {...(single ? { name: radioName } : {})}
        checked={row.selected || isLocked}
        disabled={disabled || isLocked}
        onChange={() =>
          onChange(single ? [row.device.id] : togglePickerDevice(value, row.device.id))
        }
        className="accent-primary"
        data-device-id={String(row.device.id)}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{row.device.name}</span>
        {second !== undefined && (
          <span className="truncate text-[10px] text-foreground-subtle">{second}</span>
        )}
        {note !== undefined && (
          <span
            className={isLocked ? 'text-[10px] text-foreground-subtle' : 'text-[10px] text-warning'}
          >
            {note}
          </span>
        )}
      </span>
    </label>
  )
}
