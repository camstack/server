/**
 * The leaf widgets the condition editor renders, one per catalog `valueType`.
 *
 * They are deliberately dumb: each takes the current value and an `onChange`,
 * and knows nothing about WHICH `NcConditions` key it is editing — that
 * binding is resolved from `descriptor.id` in `notification-condition-fields`
 * and applied by the dispatcher in `NotificationRuleConditions`. Keeping the
 * two apart is what lets a new catalog descriptor reuse an existing widget
 * without a hand-written form.
 *
 * Split out of `NotificationRuleConditions.tsx`, which had grown past the
 * 800-line ceiling.
 */

import type {
  NcAudioCondition,
  NcAudioMode,
  NcAudioPatch,
  NcCrossing,
  NcDeviceStateCondition,
  NcOccupancyCondition,
  NcPlateMatcher,
  NcSceneCondition,
  NcTaxonomy,
  SceneMonitor,
  TaxonomyOption,
  TaxonomyPicker,
} from '@camstack/types'
import {
  audioIsFailClosed,
  audioLabelChoices,
  audioModeOf,
  audioOrDefaults,
  isAudioLabelSelected,
  knownValues,
  NC_AUDIO_DB_MAX,
  NC_AUDIO_DB_MIN,
  NC_AUDIO_DB_OFFERED,
  NC_AUDIO_DB_STEP,
  NC_AUDIO_CONFIRM_HITS_DEFAULT,
  NC_AUDIO_CONFIRM_HITS_MAX,
  NC_AUDIO_CONFIRM_HITS_MIN,
  NC_AUDIO_CONFIRM_WINDOW_MAX_SEC,
  NC_AUDIO_CONFIRM_WINDOW_MIN_SEC,
  NC_AUDIO_CONFIRM_WINDOW_SEC_DEFAULT,
  NC_AUDIO_DEFAULTS,
  NC_AUDIO_HIT_PERCENT_MAX,
  NC_AUDIO_HIT_PERCENT_MIN,
  NC_AUDIO_SAMPLING_MAX_SEC,
  NC_AUDIO_SAMPLING_MIN_SEC,
  patchAudio,
  toggleAudioLabel,
} from '@camstack/types'
import { EventKindGlyph, Input, Select, Button, Slider } from '@camstack/ui-library'
import { Activity, Search, X, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { NC_OCCUPANCY_DEFAULTS, type RuleCameraOption } from './notification-condition-fields'
import type { DeviceFleetView } from './device-fleet-view'
import { DevicePicker } from './DevicePicker'
import {
  OptionListField,
  useEventKindOptions,
  usePlateSuggestions,
  useZoneOptions,
} from './notification-rule-pickers'
import {
  NC_CROSSING_DEFAULT,
  NC_CROSSING_OPTIONS,
  type NcCrossingOption,
  parseCrossing,
} from './notification-rules.helpers'
import { useStateLabel } from './use-state-label'
import i18n from '../../i18n/index'

export const LABEL_CLASS = 'block text-[11px] font-medium text-foreground'
export const HINT_CLASS = 'text-[10px] text-foreground-subtle mt-0.5'

interface DeviceListFieldProps {
  readonly cameras: readonly RuleCameraOption[]
  /** The whole fleet `cameras` is drawn from, and whether it ANSWERED — only
   *  an answered fleet may call an id removed or say "no cameras" (D315). A
   *  selected id `cameras` lacks is judged against the fleet: a non-camera
   *  device is named, not called removed. */
  readonly fleet: DeviceFleetView
  readonly value: readonly number[]
  readonly onChange: (next: number[]) => void
  /** True where an empty selection means ALL devices: emptying it after it
   *  held devices warns. */
  readonly emptyMeansAll?: boolean
  /** Whether the rule as OPENED had devices here — so the widening warning
   *  survives this field's remount (a tab switch), not only this mount. */
  readonly savedHadDevices?: boolean
}

/**
 * The camera picker (`DevicePicker`, D636): the selection as chips, and a
 * searchable grouped list opened only to change it. A selected id the list
 * does not draw is judged against the fleet: removed (a warning chip
 * "Device #<id> — removed"), a non-camera device (named), or unknown while the
 * fleet has not answered ("Device #<id>") — each removable. Nothing is dropped
 * from the value on a read (D49).
 */
export function DeviceListField({
  cameras,
  fleet,
  value,
  onChange,
  emptyMeansAll = false,
  savedHadDevices = false,
}: DeviceListFieldProps) {
  return (
    <DevicePicker
      devices={cameras}
      listState={fleet.state}
      fleet={fleet}
      value={value}
      onChange={onChange}
      emptyMeansAll={emptyMeansAll}
      savedHadDevices={savedHadDevices}
    />
  )
}

interface TagListFieldProps {
  readonly value: readonly string[]
  readonly placeholder: string
  readonly onChange: (next: string[]) => void
}

/** A string-array editor: chips with remove + an add-on-Enter input. */
export function TagListField({ value, placeholder, onChange }: TagListFieldProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    const v = draft.trim()
    if (v.length === 0 || value.includes(v)) {
      setDraft('')
      return
    }
    onChange([...value, v])
    setDraft('')
  }
  const remove = (v: string): void => onChange(value.filter((x) => x !== v))
  return (
    <div className="mt-1 space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded bg-surface-hover px-1.5 py-0.5 text-[11px] text-foreground"
            >
              {v}
              <Button
                variant="unstyled"
                type="button"
                onClick={() => remove(v)}
                aria-label={t('system.notificationConditionWidgets.remove', 'remove {{v}}', { v })}
                className="text-foreground-subtle hover:text-danger"
              >
                <X className="h-3 w-3" />
              </Button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        onBlur={commit}
      />
    </div>
  )
}

interface TaxonomyPickerFieldProps {
  readonly picker: TaxonomyPicker
  readonly value: readonly string[]
  /** Mutable array to match the condition value shape the form stores. */
  readonly onChange: (next: string[]) => void
}

/**
 * The grouped multi-select that replaces a free-text tag list wherever the
 * server publishes a vocabulary.
 *
 * Macros and their subs render under one header, so "animal" and "animal → dog"
 * are visibly the same family — which is what makes "match the macro, or narrow
 * to a specific label" an obvious choice rather than something you have to know
 * to type.
 *
 * Values the taxonomy does not know are NOT discarded: they render as removable
 * chips above the groups. That is the escape hatch for a custom class, and it
 * also means opening an existing rule can never silently drop a value the
 * current vocabulary happens not to list.
 */
export function TaxonomyPickerField({ picker, value, onChange }: TaxonomyPickerFieldProps) {
  const { t } = useTranslation()
  const known = useMemo(() => knownValues(picker), [picker])
  const selected = useMemo(() => new Set(value), [value])
  const custom = value.filter((v) => !known.has(v))

  const toggle = (option: string): void => {
    onChange(selected.has(option) ? value.filter((v) => v !== option) : [...value, option])
  }

  return (
    <div className="space-y-2">
      {custom.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {custom.map((v) => (
            <Button
              variant="unstyled"
              key={v}
              type="button"
              onClick={() => onChange(value.filter((x) => x !== v))}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-surface-hover"
              title={t(
                'system.notificationConditionWidgets.customValueClickToRemove',
                'Custom value — click to remove',
              )}
            >
              {v} ×
            </Button>
          ))}
        </div>
      )}
      {picker.groups.map((group) => (
        <div key={group.key}>
          <div className="text-[10px] uppercase tracking-wide text-foreground-muted mb-1">
            {group.fallbackLabel}
          </div>
          <div className="flex flex-wrap gap-1">
            {group.options.map((option) => {
              const on = selected.has(option.value)
              return (
                <Button
                  variant="unstyled"
                  key={option.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(option.value)}
                  className={
                    on
                      ? 'rounded border border-primary bg-primary/15 px-1.5 py-0.5 text-[10px] text-foreground'
                      : 'rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-surface-hover'
                  }
                >
                  {option.label}
                </Button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

interface NumberFieldProps {
  readonly value: number | undefined
  readonly min: number
  readonly max?: number
  readonly step: number
  readonly onChange: (next: number | undefined) => void
}

export function NumberField({ value, min, max, step, onChange }: NumberFieldProps) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 flex items-center gap-2">
      <Input
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        className="max-w-[8rem]"
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') {
            onChange(undefined)
            return
          }
          const n = Number(raw)
          onChange(Number.isFinite(n) ? n : undefined)
        }}
      />
      {value !== undefined && max !== undefined && (
        <Slider
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-primary"
          aria-label={t('common.valueWord')}
        />
      )}
    </div>
  )
}

interface CrossingSelectFieldProps {
  readonly value: NcCrossing | undefined
  readonly onChange: (next: NcCrossing | undefined) => void
  /**
   * Choices from the descriptor when the hub sends them. Absent = an older hub,
   * so this build's own list is used: an empty select would be worse than a
   * last-known-good one.
   */
  readonly options?: readonly {
    readonly value: string
    readonly label: string
  }[]
}

/**
 * Zone-crossing DIRECTION (R11, D690): entering (the default), leaving, or
 * both — three choices and ONE short line under them.
 *
 * An absent condition IS entering, so it is shown as "Entering" and no "not
 * set" choice is offered. The hub serves entering as the absent value `''`
 * (the wire an old viewer reads as unset); this build maps `''` and `enter`
 * to ONE Entering choice, and choosing it writes absent (`parseCrossing`), so
 * opening and closing a rule never writes a value.
 */
export function CrossingSelectField({ value, onChange, options }: CrossingSelectFieldProps) {
  const { t } = useTranslation()
  const served = crossingChoices(options ?? [])
  const choices = served.length > 0 ? served : NC_CROSSING_OPTIONS
  return (
    <div className="mt-1 space-y-1">
      <Select
        value={value ?? NC_CROSSING_DEFAULT}
        options={choices.map((o) => ({
          value: o.value,
          label: t(`notificationRules.crossing.${o.value}`, o.label),
        }))}
        onChange={(e) => onChange(parseCrossing(e.target.value))}
      />
      <p className={HINT_CLASS}>
        {t('notificationRules.crossing.hint', 'Which way the subject crosses the zone.')}
      </p>
    </div>
  )
}

/** A served crossing choice as this build lists it: `''` IS entering, once. */
function crossingChoices(
  served: readonly { readonly value: string; readonly label: string }[],
): readonly NcCrossingOption[] {
  const out: NcCrossingOption[] = []
  for (const option of served) {
    const direction =
      option.value === '' || option.value === NC_CROSSING_DEFAULT
        ? NC_CROSSING_DEFAULT
        : parseCrossing(option.value)
    if (direction === undefined || out.some((o) => o.value === direction)) continue
    out.push({ value: direction, label: option.label })
  }
  return out
}

interface ZoneListFieldProps {
  readonly deviceIds: readonly number[]
  readonly cameras: readonly RuleCameraOption[]
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
}

/** Zone picker: names shown (with the owning camera), IDS stored. */
export function ZoneListField({ deviceIds, cameras, value, onChange }: ZoneListFieldProps) {
  const { options, loading } = useZoneOptions(deviceIds, cameras)
  return (
    <OptionListField
      options={options}
      value={value}
      onChange={onChange}
      loading={loading}
      // A zone id is minted by the zone editor: it exists or it does not.
      // A typed one matches nothing, so the rule silently never fires — which
      // is why this picker has NO free-text escape hatch. Stored ids the
      // catalogue does not know still show as removable chips, so a rule that
      // became unfireable (its zone was deleted) is visible rather than tidy.
      noFreeText
      emptyHint={
        deviceIds.length === 0
          ? 'Select cameras first — a rule can only use zones those cameras actually have.'
          : 'The selected cameras have no zones. Draw one in the camera’s zone editor first.'
      }
      placeholder=""
    />
  )
}

interface EventTokensFieldProps {
  readonly deviceIds: readonly number[]
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
}

/** Event-kind picker from the per-device kind catalogue. */
export function EventTokensField({ deviceIds, value, onChange }: EventTokensFieldProps) {
  const { t } = useTranslation()
  const { options, loading } = useEventKindOptions(deviceIds)
  return (
    <OptionListField
      options={options}
      value={value}
      onChange={onChange}
      loading={loading}
      emptyHint={
        deviceIds.length === 0
          ? 'Select cameras above to pick their event kinds — or type a token.'
          : 'No event kinds reported for the selected cameras — type a token.'
      }
      placeholder={t('system.notificationConditionWidgets.eventToken', 'Event token…')}
    />
  )
}

interface OccupancyFieldProps {
  readonly deviceIds: readonly number[]
  readonly cameras: readonly RuleCameraOption[]
  /**
   * Class vocabulary for the class scope, flattened from the SHARED picker —
   * never a local class list, so the two can never disagree about what "person"
   * is called.
   *
   * It is the `occupancy` picker, not the `classes` one: MACRO CLASSES ONLY.
   * An occupancy count is read straight out of the snapshot's `byClass`, which
   * is keyed on macros, so a sub-type ("car") names a key that does not exist
   * and the counter stays 0 forever — the trap that shipped two dead rules on
   * device 102 (2026-08-12).
   */
  readonly classOptions: readonly TaxonomyOption[]
  readonly value: NcOccupancyCondition | undefined
  readonly onChange: (next: NcOccupancyCondition | undefined) => void
}

/** The op vocabulary, mirroring `NcOccupancyConditionSchema.op`. */
const OCCUPANCY_OPS: readonly { value: NcOccupancyCondition['op']; labelKey: string }[] = [
  { value: 'became-occupied', labelKey: 'system.notificationConditionWidgets.opBecameOccupied' },
  { value: 'became-free', labelKey: 'system.notificationConditionWidgets.opBecameFree' },
  { value: '>=', labelKey: 'system.notificationConditionWidgets.opCountAtLeast' },
  { value: '<=', labelKey: 'system.notificationConditionWidgets.opCountAtMost' },
] as const

/**
 * The class `<Select>` rows: the macro vocabulary, plus the STORED class when
 * the picker no longer offers it — flagged, never dropped.
 *
 * Dropping it is what a bare filter would do, and it would silently blank the
 * control for exactly the rules that are broken: a rule authored on `car` before
 * the picker was restricted keeps its dead value, and an operator looking at an
 * empty class box has no way to learn why the rule never fired. The row says so
 * in words instead, and picking a macro replaces it.
 */
function occupancyClassChoices(
  options: readonly TaxonomyOption[],
  stored: string | undefined,
): readonly TaxonomyOption[] {
  const rows = options.map((o) => ({ value: o.value, label: o.label }))
  if (stored === undefined || stored === '' || rows.some((r) => r.value === stored)) return rows
  return [
    ...rows,
    {
      value: stored,
      label: i18n.t(
        'system.notificationConditionWidgets.subTypeNeverCountsAlways',
        '{{stored}} — sub-type, never counts (always 0)',
        { stored },
      ),
    },
  ]
}

/**
 * The composite occupancy widget: zone + class + op + count + sustain edited
 * together, because they only mean anything as a set (a threshold without its
 * op is not a condition). Mirrors `NcOccupancyConditionSchema`.
 *
 * The engine behind it — the debounced per-(device, zone, class, threshold)
 * watcher with durable edge state — shipped complete; this widget is the only
 * reason the feature was unreachable (operator report, 2026-07-30).
 */
export function OccupancyField({
  deviceIds,
  cameras,
  classOptions,
  value,
  onChange,
}: OccupancyFieldProps) {
  const { t } = useTranslation()
  const { options: zoneOptions, loading } = useZoneOptions(deviceIds, cameras)
  const current = value ?? NC_OCCUPANCY_DEFAULTS
  const patch = (next: Partial<NcOccupancyCondition>): void => onChange({ ...current, ...next })
  const edgeOp = current.op === 'became-occupied' || current.op === 'became-free'
  const classChoices = occupancyClassChoices(classOptions, current.className)

  return (
    <div className="mt-1 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="min-w-[10rem]">
          <Select
            value={current.zoneId ?? ''}
            options={[
              {
                value: '',
                label: loading
                  ? t('system.notificationConditionWidgets.loadingZones', 'Loading zones…')
                  : t('system.notificationConditionWidgets.wholeFrame', '— whole frame —'),
              },
              ...zoneOptions.map((o) => ({ value: o.value, label: o.label })),
            ]}
            onChange={(e) => patch({ zoneId: e.target.value === '' ? undefined : e.target.value })}
          />
        </div>
        <div className="min-w-[9rem]">
          <Select
            value={current.className ?? ''}
            options={[
              {
                value: '',
                label: t('system.notificationConditionWidgets.anyClass', '— any class —'),
              },
              ...classChoices,
            ]}
            onChange={(e) =>
              patch({ className: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </div>
        <div className="min-w-[9rem]">
          <Select
            value={current.op}
            options={OCCUPANCY_OPS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            onChange={(e) => {
              const next = OCCUPANCY_OPS.find((o) => o.value === e.target.value)
              if (next) patch({ op: next.value })
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-subtle">
        <label className="flex items-center gap-1">
          {edgeOp
            ? t('system.notificationConditionWidgets.threshold', 'Threshold')
            : t('system.notificationConditionWidgets.count', 'Count')}
          <Input
            type="number"
            min={0}
            className="w-16"
            value={String(current.count)}
            onChange={(e) => patch({ count: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label className="flex items-center gap-1">
          {t('system.notificationConditionWidgets.holdFor', 'Hold for')}
          <Input
            type="number"
            min={0}
            max={3600}
            className="w-16"
            value={String(current.sustainSeconds)}
            onChange={(e) =>
              patch({ sustainSeconds: Math.min(3600, Math.max(0, Number(e.target.value) || 0)) })
            }
          />
          s
        </label>
        {value !== undefined ? (
          <Button
            variant="unstyled"
            type="button"
            onClick={() => onChange(undefined)}
            className="underline hover:text-foreground"
          >
            {t('system.notificationConditionWidgets.clear', 'Clear')}
          </Button>
        ) : null}
      </div>
      {deviceIds.length === 0 && (
        <p className="text-[11px] text-warning">
          {t(
            'system.notificationConditionWidgets.noCameraPickedOnThe',
            "No camera picked on the Devices tab: this watches EVERY camera's occupancy, and no zone can be offered until you choose one — a zone id belongs to a camera.",
          )}
        </p>
      )}
      <p className="text-[11px] text-foreground-subtle">
        {t(
          'system.notificationConditionWidgets.countsConfirmedTrackedObjectsFrom',
          'Counts confirmed tracked objects from zone analytics. The change must hold for the sustain window before it fires; with no snapshot for the camera or zone the rule never fires.',
        )}
      </p>
    </div>
  )
}

interface NcAudioModeChoice {
  readonly value: NcAudioMode
  readonly labelKey: string
  readonly Icon: LucideIcon
}

/**
 * The mode picker's two choices, in the order they are offered. Lucide, not
 * emoji — this row sits directly above the class chips, and one emoji left
 * beside them reads as a rendering fault rather than a style.
 */
const NC_AUDIO_MODE_CHOICES: readonly NcAudioModeChoice[] = [
  { value: 'label', labelKey: 'system.notificationConditionWidgets.audioModeLabel', Icon: Search },
  {
    value: 'level',
    labelKey: 'system.notificationConditionWidgets.audioModeLevel',
    Icon: Activity,
  },
]

interface AudioFieldProps {
  /** Server audio vocabulary; absent → the local macro catalog is offered. */
  readonly taxonomy: NcTaxonomy | undefined
  readonly value: NcAudioCondition | undefined
  readonly onChange: (next: NcAudioCondition | undefined) => void
}

/**
 * The sound widget — ONE of two modes, never both (D157).
 *
 *  - **Sounds** (label mode): pick macro classes; the rule fires on the FIRST
 *    frame the classifier labels with one of them. No hit percentage and no
 *    sampling window are shown, because there are none: the classifier labels
 *    one to three frames per episode, so a percentage of frames is a question
 *    it cannot answer, and showing the controls would be offering a knob that
 *    does nothing.
 *  - **Volume** (level mode): a dBFS floor plus the sampling window, unchanged.
 *
 * Every write goes through the SHARED `patchAudio` — the same function the
 * viewer's `AudioField` uses, so the two editors cannot disagree about what a
 * mode switch stores, and picking one mode structurally clears the other's
 * filter rather than leaving an ambiguous rule behind.
 *
 * Two more things it does that plain controls would not:
 *
 *  - the offered floor is {@link NC_AUDIO_DB_OFFERED}, and the hint says which
 *    way the scale runs. It used to offer -30, which is ABOVE most of the
 *    sounds this hub is asked about (real crying measures -55…-26 dBFS) — a
 *    seed that quietly authored a rule that could not fire;
 *  - a stored label neither the hub nor this build knows renders as an
 *    explicitly-unknown, removable choice instead of disappearing.
 */
export function AudioField({ taxonomy, value, onChange }: AudioFieldProps) {
  const { t } = useTranslation()
  const current = audioOrDefaults(value)
  const patch = (next: NcAudioPatch): void => onChange(patchAudio(value, next))
  const { choices, unknownLabels } = audioLabelChoices(taxonomy, current.labels)
  // An unauthored condition opens on SOUNDS: it is the mode that answers the
  // question people actually bring to an audio rule ("tell me when the baby
  // cries"), and the one that cannot be mis-tuned into never firing.
  const mode: NcAudioMode = audioModeOf(value) ?? 'label'

  return (
    <div className="mt-1 space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {NC_AUDIO_MODE_CHOICES.map((choice) => (
          <Button
            variant="unstyled"
            key={choice.value}
            type="button"
            aria-pressed={mode === choice.value}
            onClick={() => patch({ mode: choice.value })}
            className={`rounded border px-2 py-0.5 text-[11px] ${
              mode === choice.value
                ? 'border-primary bg-primary/15 text-foreground'
                : 'border-border text-foreground-subtle hover:bg-surface-hover'
            }`}
          >
            <span className="inline-flex items-center gap-1">
              <choice.Icon className="h-3 w-3" />
              {t(choice.labelKey)}
            </span>
          </Button>
        ))}
        {value !== undefined ? (
          <Button
            variant="unstyled"
            type="button"
            onClick={() => onChange(undefined)}
            className="ml-1 text-xs text-foreground-subtle underline hover:text-foreground"
          >
            {t('system.notificationConditionWidgets.clear', 'Clear')}
          </Button>
        ) : null}
      </div>

      {mode === 'label' ? (
        <>
          <div className="flex flex-wrap gap-1">
            {choices.map((choice) => {
              const on = isAudioLabelSelected(current.labels, choice.value)
              const tone = choice.unknown
                ? 'border-dashed border-warning text-warning'
                : on
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-foreground hover:bg-surface-hover'
              return (
                <Button
                  variant="unstyled"
                  key={choice.value}
                  type="button"
                  aria-pressed={on}
                  title={
                    choice.unknown
                      ? t(
                          'system.notificationConditionWidgets.storedByTheRuleNot',
                          'Stored by the rule — not offered by this hub',
                        )
                      : undefined
                  }
                  onClick={() => patch({ labels: toggleAudioLabel(current.labels, choice.value) })}
                  className={`rounded border px-1.5 py-0.5 text-[10px] ${tone}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {/* The SHARED class glyph, not an emoji: the same icon the
                        timeline, the events tree and the viewer draw for this
                        sound. `resolveEventKindIcon` falls back to the audio
                        glyph for a class this build does not know. */}
                    <EventKindGlyph iconId={choice.iconId} size={12} />
                    {choice.label}
                  </span>
                </Button>
              )
            })}
          </div>
          {unknownLabels.length > 0 && (
            <p className="text-[10px] text-warning">
              {t(
                'system.notificationConditionWidgets.keptFromTheRuleUnknown',
                'Kept from the rule, unknown to this hub:',
              )}{' '}
              {unknownLabels.join(', ')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-subtle">
            <label className="flex items-center gap-1">
              {t('system.notificationConditionWidgets.confirmAfter', 'Confirm after')}
              <Input
                type="number"
                min={NC_AUDIO_CONFIRM_HITS_MIN}
                max={NC_AUDIO_CONFIRM_HITS_MAX}
                step={1}
                className="w-16"
                value={String(current.confirmHits ?? NC_AUDIO_CONFIRM_HITS_DEFAULT)}
                onChange={(e) => patch({ confirmHits: Number(e.target.value) })}
              />
              {t('system.notificationConditionWidgets.frames')}
            </label>
            <label className="flex items-center gap-1">
              {t('system.notificationConditionWidgets.within')}
              <Input
                type="number"
                min={NC_AUDIO_CONFIRM_WINDOW_MIN_SEC}
                max={NC_AUDIO_CONFIRM_WINDOW_MAX_SEC}
                step={1}
                className="w-16"
                value={String(current.confirmWindowSec ?? NC_AUDIO_CONFIRM_WINDOW_SEC_DEFAULT)}
                onChange={(e) => patch({ confirmWindowSec: Number(e.target.value) })}
              />
              s
            </label>
          </div>
          <p className="text-[11px] text-foreground-subtle">
            {t('system.notificationConditionWidgets.audioConfirmHint', {
              hits: NC_AUDIO_CONFIRM_HITS_DEFAULT,
              window: NC_AUDIO_CONFIRM_WINDOW_SEC_DEFAULT,
            })}
          </p>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-subtle">
            <label className="flex items-center gap-1">
              {t('system.notificationConditionWidgets.louderThan', 'Louder than')}
              <Input
                type="number"
                min={NC_AUDIO_DB_MIN}
                max={NC_AUDIO_DB_MAX}
                step={NC_AUDIO_DB_STEP}
                className="w-20"
                value={String(current.dbThreshold ?? NC_AUDIO_DB_OFFERED)}
                onChange={(e) => patch({ dbThreshold: Number(e.target.value) })}
              />
              dBFS
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-subtle">
            <label className="flex items-center gap-1">
              {t('system.notificationConditionWidgets.hits', 'Hits')}
              <Input
                type="number"
                min={NC_AUDIO_HIT_PERCENT_MIN}
                max={NC_AUDIO_HIT_PERCENT_MAX}
                step={5}
                className="w-16"
                value={String(current.hitPercent)}
                onChange={(e) => patch({ hitPercent: Number(e.target.value) })}
              />
              {t('system.notificationConditionWidgets.hitsPercentDefault', {
                value: NC_AUDIO_DEFAULTS.hitPercent,
              })}
            </label>
            <label className="flex items-center gap-1">
              {t('system.notificationConditionWidgets.over')}
              <Input
                type="number"
                min={NC_AUDIO_SAMPLING_MIN_SEC}
                max={NC_AUDIO_SAMPLING_MAX_SEC}
                step={5}
                className="w-16"
                value={String(current.samplingSeconds)}
                onChange={(e) => patch({ samplingSeconds: Number(e.target.value) })}
              />
              {t('system.notificationConditionWidgets.secondsDefault', {
                value: NC_AUDIO_DEFAULTS.samplingSeconds,
              })}
            </label>
          </div>
          <p className="text-[11px] text-foreground-subtle">
            {t('system.notificationConditionWidgets.dbfsHint', { min: NC_AUDIO_DB_MIN })}
          </p>
        </>
      )}

      {audioIsFailClosed(value) ? (
        <p className="text-[11px] text-warning">
          {t(
            'system.notificationConditionWidgets.withNeitherASoundNor',
            'With neither a sound nor a level threshold this can never match — every sample would be a hit, so the engine refuses it rather than notifying on silence.',
          )}
        </p>
      ) : null}
    </div>
  )
}

interface PlateMatcherFieldProps {
  readonly value: NcPlateMatcher | undefined
  readonly onChange: (next: NcPlateMatcher | undefined) => void
}

/** Fuzzy plate matcher — plate tags + a max-Levenshtein-distance number. */
export function PlateMatcherField({ value, onChange }: PlateMatcherFieldProps) {
  const { t } = useTranslation()
  const values = value?.values ?? []
  const maxDistance = value?.maxDistance ?? 1
  const setValues = (next: string[]): void =>
    onChange(next.length > 0 ? { values: next, maxDistance } : undefined)
  const setDistance = (next: number): void =>
    onChange(values.length > 0 ? { values, maxDistance: next } : undefined)
  // Known plates from the gallery as one-click suggestions (spec D5) — the
  // matcher stays free text (a plate you EXPECT may never have been read yet).
  const suggestions = usePlateSuggestions().filter((t) => !values.includes(t))
  return (
    <div className="mt-1 space-y-1.5">
      <TagListField
        value={values}
        placeholder={t('system.notificationConditionWidgets.plateText', 'Plate text…')}
        onChange={setValues}
      />
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-foreground-subtle">
            {t('system.notificationConditionWidgets.seen', 'Seen:')}
          </span>
          {suggestions.slice(0, 12).map((t) => (
            <Button
              variant="unstyled"
              key={t}
              type="button"
              onClick={() => setValues([...values, t])}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            >
              {t}
            </Button>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2 text-[11px] text-foreground-subtle">
        {t('system.notificationConditionWidgets.maxDistance', 'Max distance')}
        <Input
          type="number"
          min={0}
          max={3}
          step={1}
          value={maxDistance}
          className="max-w-[5rem]"
          onChange={(e) => {
            const n = Number(e.target.value)
            setDistance(Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 1)
          }}
        />
      </label>
    </div>
  )
}

interface DeviceStateFieldProps {
  /** Every device that can be gated on, with the states each one offers. */
  readonly gateable: readonly GateableDevice[]
  readonly value: NcDeviceStateCondition | undefined
  readonly onChange: (next: NcDeviceStateCondition | undefined) => void
}

/** A device the gate can read, and the words it can be in. */
export interface GateableDevice {
  readonly id: number
  readonly name: string
  readonly states: readonly string[]
}

/**
 * "Only while <device> is <state>."
 *
 * The state choices come from the SAME table the engine reads
 * (`stateVocabularyFor`), resolved by the page — so this picker can never offer
 * a value the gate would not recognise. A device with no gateable capability is
 * not in the list at all rather than present and unusable.
 */
export function DeviceStateField({ gateable, value, onChange }: DeviceStateFieldProps) {
  const { t } = useTranslation()
  const label = useStateLabel()
  const selected = gateable.find((d) => d.id === value?.deviceId)
  const chosen = new Set(value?.states ?? [])

  const pickDevice = (raw: string): void => {
    const id = Number(raw)
    if (!Number.isFinite(id) || id === 0) return onChange(undefined)
    // Changing the device drops the states: they belonged to the old device's
    // vocabulary and would silently never match on the new one.
    onChange({ deviceId: id, states: [] })
  }

  const toggleState = (state: string): void => {
    if (value === undefined) return
    const next = new Set(chosen)
    if (next.has(state)) next.delete(state)
    else next.add(state)
    // An empty state list matches nothing; the schema rejects it, so drop the
    // whole condition instead of persisting something that can never fire.
    onChange(next.size === 0 ? undefined : { deviceId: value.deviceId, states: [...next] })
  }

  return (
    <div className="mt-1 space-y-2">
      <Select
        value={value === undefined ? '' : String(value.deviceId)}
        options={[
          {
            value: '',
            label: t('system.notificationConditionWidgets.noDeviceGate', '— no device gate —'),
          },
          ...gateable.map((d) => ({ value: String(d.id), label: d.name })),
        ]}
        onChange={(e) => pickDevice(e.target.value)}
      />
      {selected !== undefined && (
        <div className="flex flex-wrap gap-1.5">
          {selected.states.map((state) => (
            <Button
              variant="unstyled"
              key={state}
              type="button"
              onClick={() => toggleState(state)}
              className={
                chosen.has(state)
                  ? 'rounded-md border border-primary bg-primary/10 px-2 py-0.5 text-[11px] text-primary'
                  : 'rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground-subtle'
              }
            >
              {label(state)}
            </Button>
          ))}
        </div>
      )}
      {selected !== undefined && selected.states.length === 0 && (
        <p className={HINT_CLASS}>
          {t(
            'system.notificationConditionWidgets.thisDeviceReportsNoState',
            'This device reports no state the gate can read, so it cannot arm a rule.',
          )}
        </p>
      )}
      {value !== undefined && (
        <p className={HINT_CLASS}>
          {t(
            'system.notificationConditionWidgets.theRuleIsSilentWhile',
            'The rule is silent while the device is in any other state — including when its state cannot be read at all.',
          )}
        </p>
      )}
    </div>
  )
}

/** A scene the gate can read, with the state it is in RIGHT NOW. */
export interface GateableScene {
  readonly sceneId: string
  readonly deviceId: number
  /** The camera's name — a scene label alone is ambiguous across cameras. */
  readonly cameraName: string
  readonly label: string
  readonly verdict: SceneMonitor['verdict']
  readonly latched: boolean
  /** Which boolean the scene itself declares drives notification rules. */
  readonly emit: SceneMonitor['emit']
}

/** "Diverged (changed) · Latched" — the live state, shown next to the picker. */
function sceneStateWord(scene: GateableScene, label: (key: string) => string): string {
  const live = label(scene.verdict)
  return scene.latched ? `${live} · ${label('latched')}` : live
}

interface SceneConditionFieldProps {
  /** Every scene on every camera, with its live state. Empty on a hub that
   *  cannot answer — the condition then offers no scene rather than one that
   *  could never match. */
  readonly scenes: readonly GateableScene[]
  readonly value: NcSceneCondition | undefined
  readonly onChange: (next: NcSceneCondition | undefined) => void
}

/**
 * "Only while <scene> is <matched|diverged>." — a GATE, like `deviceState`
 * beside it: it narrows a rule that already has a trigger.
 *
 * The live state is shown next to every option, because the common mistake is
 * picking the polarity backwards. The read select is three-state: absent
 * follows the scene's own setting (`SceneMonitor.emit`, D62). What a scene is
 * and how its gate reads is the Scenes page's documentation, not this
 * editor's (R10, D690) — the editor keeps one line.
 */
export function SceneConditionField({ scenes, value, onChange }: SceneConditionFieldProps) {
  const { t } = useTranslation()
  const label = useStateLabel()
  const selected = scenes.find((s) => s.sceneId === value?.sceneId)

  const pickScene = (sceneId: string): void => {
    if (sceneId === '') return onChange(undefined)
    const scene = scenes.find((s) => s.sceneId === sceneId)
    if (scene === undefined) return onChange(undefined)
    // The polarity and the read mode are CARRIED OVER: changing which scene the
    // rule watches is not a reason to silently reset a choice the operator
    // already made (unlike `DeviceStateField`, where the states belong to the
    // old device's vocabulary and cannot survive the switch).
    onChange({
      sceneId,
      deviceId: scene.deviceId,
      requiredState: value?.requiredState ?? 'diverged',
      ...(value?.latched !== undefined ? { latched: value.latched } : {}),
    })
  }

  const setRequired = (raw: string): void => {
    if (value === undefined) return
    onChange({ ...value, requiredState: raw === 'matched' ? 'matched' : 'diverged' })
  }

  const setRead = (raw: string): void => {
    if (value === undefined) return
    if (raw === '') {
      const { latched: _dropped, ...rest } = value
      return onChange(rest)
    }
    onChange({ ...value, latched: raw === 'latched' })
  }

  if (scenes.length === 0) {
    return (
      <p className={HINT_CLASS}>
        {t('notificationRules.scene.none', 'No scenes yet — create one on the Scenes page.')}
      </p>
    )
  }

  return (
    <div className="mt-1 space-y-2">
      <Select
        value={value?.sceneId ?? ''}
        options={[
          { value: '', label: t('notificationRules.scene.noGate', '— no scene gate —') },
          ...scenes.map((s) => ({
            value: s.sceneId,
            label: `${s.cameraName} · ${s.label} — ${sceneStateWord(s, label)}`,
          })),
        ]}
        onChange={(e) => pickScene(e.target.value)}
      />
      {value !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[11px] text-foreground-subtle">
            {t('notificationRules.scene.onlyWhile', 'Only while it is')}
            <Select
              value={value.requiredState}
              options={[
                { value: 'diverged', label: label('diverged') },
                { value: 'matched', label: label('matched') },
              ]}
              onChange={(e) => setRequired(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-foreground-subtle">
            {t('notificationRules.scene.read', 'Read')}
            <Select
              value={value.latched === undefined ? '' : value.latched ? 'latched' : 'live'}
              options={[
                {
                  value: '',
                  label:
                    selected === undefined
                      ? t('notificationRules.scene.readOwn', "The scene's own setting")
                      : `${t('notificationRules.scene.readOwn', "The scene's own setting")} (${label(selected.emit)})`,
                },
                { value: 'latched', label: label('latched') },
                { value: 'live', label: label('live') },
              ]}
              onChange={(e) => setRead(e.target.value)}
            />
          </label>
        </div>
      )}
      {selected !== undefined && (
        <p className={HINT_CLASS}>
          {t('notificationRules.scene.rightNow', 'Right now:')} {sceneStateWord(selected, label)}
        </p>
      )}
      {value !== undefined && selected === undefined && (
        <p className={HINT_CLASS}>
          {t(
            'notificationRules.scene.missing',
            'This scene no longer exists — pick another or remove the gate.',
          )}
        </p>
      )}
    </div>
  )
}
