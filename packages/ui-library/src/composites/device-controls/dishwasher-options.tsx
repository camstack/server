/**
 * What a dishwasher reports that its device card does not draw: the option
 * toggles (half load, hygiene plus, extra dry, intensive zone, VarioSpeed+,
 * child lock), the delayed start, the raised events and the care reminders.
 * The device page shows it under the card; the card stays the approved scene.
 *
 * UNKNOWN IS NOT OFF. A setting the appliance has not reported is hidden while
 * the appliance is reachable (it does not offer it) and shown as unknown — a
 * disabled "mixed" box — while it is not. A toggle is drawn only when the
 * device's binding implements its method.
 */
import type { DeviceProxy, DishwasherStatus } from '@camstack/types'
import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { Checkbox } from '../../primitives/checkbox'
import { type BindingMethods, bindingImplements } from '../device-card/connected/use-card-common'
import { SectionCard } from '../section-card'
import type { DeviceControlProps } from './control-registry'
import { featureLabel, formatDuration } from './dishwasher-control'

type DishwasherCap = NonNullable<DeviceProxy['dishwasher']>

type OptionSetterName =
  | 'setHalfLoad'
  | 'setHygienePlus'
  | 'setExtraDry'
  | 'setIntensiveZone'
  | 'setVarioSpeedPlus'
  | 'setChildLock'

/**
 * Salt and rinse aid are consumable items (D915). Their events must not
 * reappear here — the Consumables section is the only surface.
 */
export function isConsumableDishwasherEvent(event: string): boolean {
  const short = (event.split('.').pop() ?? event).toLowerCase()
  return short.includes('salt') || short.includes('rinse')
}

/** Raised events the page may name. Consumable events are dropped. */
export function visibleDishwasherEvents(events: readonly string[]): readonly string[] {
  return events.filter((event) => !isConsumableDishwasherEvent(event))
}

type OptionKey =
  | 'halfLoad'
  | 'hygienePlus'
  | 'extraDry'
  | 'intensiveZone'
  | 'varioSpeedPlus'
  | 'childLock'

interface OptionRow {
  readonly key: OptionKey
  readonly method: OptionSetterName
  readonly label: string
}

export interface DishwasherOptionsPanelProps extends DeviceControlProps {
  /**
   * The device's bindings. Absent until they answered: a toggle is drawn only
   * once its method is declared (an entry with no method list declares all).
   */
  readonly entries: readonly BindingMethods[] | undefined
}

/**
 * The dishwasher's options and reminders, as a page section. Draws nothing
 * when the device has no `dishwasher` cap, or nothing of this to show.
 */
export function DishwasherOptionsPanel({
  trpc,
  deviceId,
  entries,
}: DishwasherOptionsPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<DishwasherCap, DishwasherStatus>({
    trpc,
    deviceId,
    cap: (d) => d.dishwasher,
    slice: (d) => d.state.dishwasher,
  })
  if (cap === undefined || slice === undefined) return null

  const link = slice.availability === 'available'
  const busy = !available || !link
  const optionsLocked = slice.childLock === true
  const implemented = (method: string): boolean => bindingImplements(entries, 'dishwasher', method)

  const rows: readonly OptionRow[] = [
    {
      key: 'halfLoad',
      method: 'setHalfLoad',
      label: t('uiLibrary.dishwasher.halfLoad', 'Half load'),
    },
    {
      key: 'hygienePlus',
      method: 'setHygienePlus',
      label: t('uiLibrary.dishwasher.hygienePlus', 'Hygiene plus'),
    },
    {
      key: 'extraDry',
      method: 'setExtraDry',
      label: t('uiLibrary.dishwasher.extraDry', 'Extra dry'),
    },
    {
      key: 'intensiveZone',
      method: 'setIntensiveZone',
      label: t('uiLibrary.dishwasher.intensiveZone', 'Intensive zone'),
    },
    {
      key: 'varioSpeedPlus',
      method: 'setVarioSpeedPlus',
      label: t('uiLibrary.dishwasher.varioSpeedPlus', 'VarioSpeed+'),
    },
    {
      key: 'childLock',
      method: 'setChildLock',
      label: t('uiLibrary.dishwasher.childLock', 'Child lock'),
    },
  ]
  const toggles = rows.filter(
    (row) => implemented(row.method) && !(slice[row.key] === null && link),
  )
  const events = visibleDishwasherEvents(slice.activeEvents)
  const delayed = slice.delayedStart !== null && slice.delayedStart > 0
  const reminders = slice.filterCleaningDue === true || slice.machineCareDue === true
  const runsLeft =
    typeof slice.machineCareRemainingRuns === 'number' ? slice.machineCareRemainingRuns : null
  if (toggles.length === 0 && events.length === 0 && !delayed && !reminders && runsLeft === null)
    return null

  return (
    <SectionCard
      headingId={`dishwasher-options-${String(deviceId)}`}
      title={t('uiLibrary.dishwasher.options', 'Options')}
      testId="dishwasher-options"
    >
      <div className="flex flex-col gap-3 text-xs">
        {delayed || events.length > 0 || reminders || runsLeft !== null ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {delayed ? (
              <span className="tabular-nums text-foreground-subtle">
                {t('uiLibrary.dishwasher.startsIn', 'Starts in {{time}}', {
                  time: formatDuration(slice.delayedStart ?? 0, t),
                })}
              </span>
            ) : null}
            {events.map((event) => (
              <span key={event} className="text-warning" title={event}>
                {featureLabel(event)}
              </span>
            ))}
            {slice.filterCleaningDue === true ? (
              <span className="text-warning">
                {t('uiLibrary.dishwasher.filterDue', 'Filter cleaning due')}
              </span>
            ) : null}
            {slice.machineCareDue === true ? (
              <span className="text-warning">
                {t('uiLibrary.dishwasher.machineCareDue', 'Machine care due')}
              </span>
            ) : null}
            {runsLeft !== null && slice.machineCareDue !== true ? (
              <span className="tabular-nums text-foreground-subtle">
                {t('uiLibrary.dishwasher.machineCareIn', 'Machine care in {{count}} runs', {
                  count: runsLeft,
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        {toggles.length > 0 ? (
          <div className="flex flex-wrap gap-4">
            {toggles.map((row) => (
              <ToggleRow
                key={row.key}
                label={row.label}
                checked={slice[row.key]}
                shown={link}
                busy={busy || (row.key !== 'childLock' && optionsLocked)}
                onChange={(on) => void cap[row.method]({ on })}
              />
            ))}
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}

interface ToggleRowProps {
  readonly label: string
  readonly checked: boolean | null
  /** True while the link is up and the appliance is decodable. */
  readonly shown: boolean
  readonly busy: boolean
  readonly onChange: (on: boolean) => void
}

/**
 * One boolean setting. `checked === null` is "the appliance has not said": on a reachable
 * appliance that means it does not offer the setting (hidden); on an unreachable one the
 * setting is shown but disabled and marked unknown — never as an unchecked box.
 */
function ToggleRow({ label, checked, shown, busy, onChange }: ToggleRowProps): ReactNode {
  const t = useUiText()
  if (checked === null && shown) return null
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <Checkbox
        checked={checked === true}
        aria-checked={checked === null ? 'mixed' : checked}
        disabled={busy || checked === null}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
        onClick={(e) => {
          e.stopPropagation()
        }}
        className="rounded border-border"
      />
      <span>{label}</span>
      {checked === null && (
        <span className="text-foreground-subtle">
          {t('uiLibrary.dishwasher.unknownValue', '—')}
        </span>
      )}
    </label>
  )
}
