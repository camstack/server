/**
 * <DeviceSelectorPicker> — the operator-facing editor for a v3
 * {@link DeviceSelector}: the "on WHICH devices" half of a scope grant.
 *
 * Four tabs, one per selector kind, because the kinds are not interchangeable
 * and the operator has to choose between them deliberately:
 *
 *   All      → every device, now and forever. DYNAMIC.
 *   By type  → every device of a `DeviceType`. DYNAMIC — a camera added
 *              tomorrow is covered with no re-grant.
 *   By room  → every device carrying an operator-assigned `location` label.
 *              DYNAMIC. Rendered ONLY when the fleet actually has labels;
 *              an empty tab reads as a broken feature, not as "unused".
 *   Chosen   → an explicit id list. STATIC — this is the one that does NOT
 *              cover a new device, and the tab says so.
 *
 * Counts are LIVE (computed off `deviceManager.listAll`) so "Camera · 12"
 * answers "how much am I granting" without leaving the panel.
 *
 * Shared, not forked: the raw `<ScopePicker>` device row and the simple
 * Access panel both render this. Two editors for one wire shape is how a
 * selector ends up meaning different things in two places.
 */
import { useUiText, UiTrans, defaultUiText, type UiTextFn } from '../contexts/ui-text'
import { useMemo, useRef, useState } from 'react'
import { useSearchFieldHotkey } from '../hotkeys/use-search-field-hotkey'
import { Link2, Search } from 'lucide-react'
import { DeviceType, type DeviceSelector } from '@camstack/types'

import { useDeviceManagerListAll } from '../generated/system-hooks'

/** The device fields this picker reads. */
export interface SelectorDevice {
  readonly id: number
  readonly name: string
  readonly type: DeviceType
  readonly location: string | null
  readonly parentDeviceId: number | null
}

export type DeviceSelectorTab = 'all' | 'types' | 'locations' | 'ids'

interface DeviceSelectorPickerProps {
  readonly value: DeviceSelector
  readonly onChange: (next: DeviceSelector) => void
  /**
   * `includeLinked` lives next to the selector because it changes what the
   * selector REACHES, not what it selects. Omit both to hide the toggle
   * (the raw picker renders it per row instead).
   */
  readonly includeLinked?: boolean
  readonly onIncludeLinkedChange?: (next: boolean) => void
  /**
   * Ids the CALLER may delegate. `null` = unclamped (admin). A clamped
   * picker hides devices outside the set from the Chosen tab and reports the
   * counts it can actually see.
   */
  readonly clampToDeviceIds?: readonly number[] | null
  /** Compact spacing for the raw picker's inline row. */
  readonly dense?: boolean
}

/** Human label for a `DeviceType` — 'lawn-mower' → 'Lawn mower'. */
export function deviceTypeLabel(type: string): string {
  const spaced = type.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Which tab a selector belongs to. */
export function tabForSelector(selector: DeviceSelector): DeviceSelectorTab {
  return selector.kind
}

/**
 * A fresh selector when the operator switches tabs. Switching is destructive
 * by nature — an `ids` list has no meaning as a `types` list — so each tab
 * starts empty rather than guessing a translation.
 */
function emptySelectorFor(tab: DeviceSelectorTab): DeviceSelector {
  switch (tab) {
    case 'all':
      return { kind: 'all' }
    case 'types':
      return { kind: 'types', types: [] }
    case 'locations':
      return { kind: 'locations', locations: [] }
    case 'ids':
      return { kind: 'ids', ids: [] }
  }
}

interface CountedOption {
  readonly value: string
  readonly label: string
  readonly count: number
}

export function DeviceSelectorPicker({
  value,
  onChange,
  includeLinked,
  onIncludeLinkedChange,
  clampToDeviceIds,
  dense = false,
}: DeviceSelectorPickerProps): React.ReactElement {
  const t = useUiText()
  const { data: rawDevices } = useDeviceManagerListAll({})
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useSearchFieldHotkey(searchRef)

  const devices = useMemo<readonly SelectorDevice[]>(() => {
    const all = (rawDevices ?? []).map(
      (d): SelectorDevice => ({
        id: d.id,
        name: d.name,
        type: d.type,
        location: d.location,
        parentDeviceId: d.parentDeviceId,
      }),
    )
    if (clampToDeviceIds == null) return all
    const allowed = new Set(clampToDeviceIds)
    return all.filter((d) => allowed.has(d.id))
  }, [rawDevices, clampToDeviceIds])

  const typeOptions = useMemo<readonly CountedOption[]>(() => {
    const counts = new Map<string, number>()
    for (const d of devices) counts.set(d.type, (counts.get(d.type) ?? 0) + 1)
    // A type already in the selector stays listed even at count 0, so a
    // selection is never silently dropped by the fleet changing under it.
    if (value.kind === 'types') {
      for (const type of value.types) if (!counts.has(type)) counts.set(type, 0)
    }
    return [...counts.entries()]
      .map(([type, count]) => ({ value: type, label: deviceTypeLabel(type), count }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [devices, value])

  const locationOptions = useMemo<readonly CountedOption[]>(() => {
    const counts = new Map<string, number>()
    for (const d of devices) {
      if (d.location === null || d.location.length === 0) continue
      counts.set(d.location, (counts.get(d.location) ?? 0) + 1)
    }
    if (value.kind === 'locations') {
      for (const l of value.locations) if (!counts.has(l)) counts.set(l, 0)
    }
    return [...counts.entries()]
      .map(([location, count]) => ({ value: location, label: location, count }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [devices, value])

  /** The Room tab exists only when the fleet has rooms. */
  const hasLocations = locationOptions.length > 0

  const visibleDevices = useMemo<readonly SelectorDevice[]>(() => {
    const q = search.trim().toLowerCase()
    const matched =
      q.length === 0
        ? devices
        : devices.filter(
            (d) =>
              d.name.toLowerCase().includes(q) ||
              String(d.id).includes(q) ||
              (d.location ?? '').toLowerCase().includes(q),
          )
    return [...matched].sort((a, b) => a.name.localeCompare(b.name))
  }, [devices, search])

  const activeTab = tabForSelector(value)

  const tabs: readonly { id: DeviceSelectorTab; label: string }[] = [
    { id: 'all', label: t('uiLibrary.deviceSelectorPicker.tabAll', 'All') },
    { id: 'types', label: t('uiLibrary.deviceSelectorPicker.tabTypes', 'By type') },
    ...(hasLocations || activeTab === 'locations'
      ? [
          {
            id: 'locations' as const,
            label: t('uiLibrary.deviceSelectorPicker.tabRooms', 'By room'),
          },
        ]
      : []),
    { id: 'ids', label: t('uiLibrary.deviceSelectorPicker.tabChosen', 'Chosen') },
  ]

  const toggleType = (type: string): void => {
    const current = value.kind === 'types' ? value.types : []
    const next = current.some((t) => String(t) === type)
      ? current.filter((t) => String(t) !== type)
      : [...current, ...typeFromString(type)]
    onChange({ kind: 'types', types: next })
  }

  const toggleLocation = (location: string): void => {
    const current = value.kind === 'locations' ? value.locations : []
    const next = current.includes(location)
      ? current.filter((l) => l !== location)
      : [...current, location]
    onChange({ kind: 'locations', locations: next })
  }

  const toggleId = (id: number): void => {
    const current = value.kind === 'ids' ? value.ids : []
    const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id]
    onChange({ kind: 'ids', ids: next })
  }

  const pad = dense ? 'p-2' : 'p-3'

  return (
    <div className="space-y-2">
      {/* Tab bar — wraps rather than scrolling, so no second scroll context. */}
      <div className="flex flex-wrap gap-1 border-b border-border pb-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(emptySelectorFor(tab.id))}
            className={`shrink-0 whitespace-nowrap rounded px-2 py-1 text-[11px] transition-colors ${
              activeTab === tab.id
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-foreground-subtle hover:bg-foreground-subtle/10 hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'all' && (
        <div className={`rounded border border-border bg-surface ${pad}`}>
          <p className="text-[11px] text-foreground">
            {t(
              'uiLibrary.deviceSelectorPicker.everyDevice',
              'Every device in this deployment — {{count}} right now.',
              { count: devices.length },
            )}
          </p>
          <p className="mt-1 text-[10px] text-foreground-subtle">
            {t(
              'uiLibrary.deviceSelectorPicker.laterCovered',
              'Devices added later are covered automatically.',
            )}
          </p>
        </div>
      )}

      {activeTab === 'types' && (
        <CheckboxGrid
          options={typeOptions}
          selected={value.kind === 'types' ? value.types.map((type) => String(type)) : []}
          onToggle={toggleType}
          emptyLabel={t(
            'uiLibrary.deviceSelectorPicker.noTypes',
            'No devices to pick a type from.',
          )}
          footnote={t(
            'uiLibrary.deviceSelectorPicker.typesFootnote',
            'Devices of a checked type are covered automatically as they are added.',
          )}
          pad={pad}
        />
      )}

      {activeTab === 'locations' && (
        <CheckboxGrid
          options={locationOptions}
          selected={value.kind === 'locations' ? [...value.locations] : []}
          onToggle={toggleLocation}
          emptyLabel={t(
            'uiLibrary.deviceSelectorPicker.noRooms',
            'No device has a room assigned yet.',
          )}
          footnote={t(
            'uiLibrary.deviceSelectorPicker.roomsFootnote',
            'A device with no room set is never covered by a room rule.',
          )}
          pad={pad}
        />
      )}

      {activeTab === 'ids' && (
        <div className={`rounded border border-border bg-surface ${pad} space-y-2`}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-foreground-subtle" />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('uiLibrary.deviceSelectorPicker.search', 'Search devices…')}
              className="w-full rounded border border-border bg-background py-1 pl-7 pr-2 text-[11px] text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="max-h-56 overflow-auto rounded border border-border">
            {visibleDevices.length === 0 && (
              <p className="px-2 py-3 text-[10px] italic text-foreground-subtle">
                {t('uiLibrary.deviceSelectorPicker.noMatch', 'No device matches.')}
              </p>
            )}
            {visibleDevices.map((d) => {
              const checked = value.kind === 'ids' && value.ids.includes(d.id)
              return (
                <label
                  key={d.id}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-foreground-subtle/10"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleId(d.id)}
                    className="rounded border-border focus:ring-primary"
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">{d.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-foreground-subtle">
                    #{d.id}
                    {d.location !== null && d.location.length > 0 ? ` · ${d.location}` : ''}
                  </span>
                </label>
              )
            })}
          </div>
          <p className="text-[10px] text-foreground-subtle">
            <UiTrans
              uiKey="uiLibrary.deviceSelectorPicker.fixedList"
              fallback="A fixed list — a device added later is <0>not</0> covered until you edit this."
              components={[<span key="n" className="font-medium" />]}
            />
          </p>
        </div>
      )}

      {includeLinked !== undefined && onIncludeLinkedChange !== undefined && (
        <IncludeLinkedToggle value={includeLinked} onChange={onIncludeLinkedChange} pad={pad} />
      )}
    </div>
  )
}

/**
 * Turn a raw string back into the `DeviceType` union without a cast. The
 * enum's values ARE the strings, so a lookup over its members is both exact
 * and total — an unknown string yields no entry and selects nothing.
 */
function typeFromString(raw: string): DeviceType[] {
  return Object.values(DeviceType).filter((t) => String(t) === raw)
}

interface CheckboxGridProps {
  readonly options: readonly CountedOption[]
  readonly selected: readonly string[]
  readonly onToggle: (value: string) => void
  readonly emptyLabel: string
  readonly footnote: string
  readonly pad: string
}

function CheckboxGrid({
  options,
  selected,
  onToggle,
  emptyLabel,
  footnote,
  pad,
}: CheckboxGridProps): React.ReactElement {
  return (
    <div className={`rounded border border-border bg-surface ${pad} space-y-2`}>
      {options.length === 0 ? (
        <p className="text-[10px] italic text-foreground-subtle">{emptyLabel}</p>
      ) : (
        <div className="grid max-h-56 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1 overflow-auto">
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-foreground-subtle/10"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => onToggle(o.value)}
                className="rounded border-border focus:ring-primary"
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{o.label}</span>
              <span className="shrink-0 font-mono text-[10px] text-foreground-subtle">
                {o.count}
              </span>
            </label>
          ))}
        </div>
      )}
      <p className="text-[10px] text-foreground-subtle">{footnote}</p>
    </div>
  )
}

interface IncludeLinkedToggleProps {
  readonly value: boolean
  readonly onChange: (next: boolean) => void
  readonly pad: string
}

/**
 * The toggle whose OFF state is a real semantic restriction, so the hint says
 * what it costs rather than describing the mechanism: without it, an operator
 * granted a camera cannot fire the siren or floodlight attached to it,
 * because `create` does not inherit parent → child by default.
 */
function IncludeLinkedToggle({
  value,
  onChange,
  pad,
}: IncludeLinkedToggleProps): React.ReactElement {
  const t = useUiText()
  return (
    <div className={`rounded border border-border bg-surface ${pad}`}>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 rounded border-border focus:ring-primary"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            <Link2 className="h-3 w-3" />
            {t('uiLibrary.deviceSelectorPicker.includeLinked', 'Include linked devices')}
          </span>
          <span className="mt-0.5 block text-[10px] text-foreground-subtle">
            {value ? (
              <>
                {t(
                  'uiLibrary.deviceSelectorPicker.linkedOn',
                  'Accessories attached to a granted camera — siren, floodlight, PIR — are covered too.',
                )}
              </>
            ) : (
              <>
                <UiTrans
                  uiKey="uiLibrary.deviceSelectorPicker.linkedOff"
                  fallback="Only the devices selected above. An operator granted a camera will <0>not</0> be able to trigger the siren or light attached to it."
                  components={[<span key="n" className="font-medium text-foreground" />]}
                />
              </>
            )}
          </span>
        </span>
      </label>
    </div>
  )
}

/** Summary line for a selector — used by the raw picker's collapsed row. */
export function describeDeviceSelector(
  selector: DeviceSelector,
  t: UiTextFn = defaultUiText,
): string {
  switch (selector.kind) {
    case 'all':
      return t('uiLibrary.deviceSelectorPicker.allDevices', 'All devices')
    case 'ids':
      return selector.ids.length === 0
        ? t('uiLibrary.deviceSelectorPicker.noDevice', 'No device chosen')
        : t(
            'uiLibrary.deviceSelectorPicker.deviceCount',
            { one: '{{count}} device', other: '{{count}} devices' },
            { count: selector.ids.length },
          )
    case 'types':
      return selector.types.length === 0
        ? t('uiLibrary.deviceSelectorPicker.noType', 'No type chosen')
        : selector.types.map((type) => deviceTypeLabel(String(type))).join(', ')
    case 'locations':
      return selector.locations.length === 0
        ? t('uiLibrary.deviceSelectorPicker.noRoom', 'No room chosen')
        : selector.locations.join(', ')
  }
}
