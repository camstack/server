/**
 * The trailing value of a Sensor or Control row, drawn from the projected row model
 * (`heroLayout.getRowModels`, D1023) — the same model the device page draws, so the
 * row and the card never disagree.
 *
 *   - a simple sensor: its measurement, through the operator's display resolution
 *     (unit preference, device override, role default, precision);
 *   - a control device: its primary control (a number field, with or without bounds,
 *     a choice, a text field). A number is shown and typed in the display unit and
 *     sent in the base unit, exactly as the control panel does.
 *
 * While the row model is unanswered nothing is drawn (not-yet-known never looks like
 * "no value", D315). When the server has no row model for the device, or the model
 * carries nothing the row edits inline (a sensor with two readings, a date control,
 * an action or a toggle), the caller's `fallback` — today's control — draws instead.
 */
import {
  heroArgsWithValue,
  type HeroCall,
  type HeroControl,
  type HeroMeasurement,
} from '@camstack/types'
import { type ReactNode, useCallback, useState } from 'react'
import { useTrpcClient } from '../../contexts/system-context'
import { useUiText } from '../../contexts/ui-text'
import { useUnitPreferences } from '../../contexts/unit-preferences'
import { cn } from '../../lib/cn'
import { Select } from '../../primitives/select'
import {
  controlQuantityOf,
  numericControlDisplay,
  NumericControl,
  TextControl,
} from '../device-controls/control-panel'
import { useAlertIfAvailable } from '../confirm-dialog'
import { callHeroAction } from '../hero-model/call-hero-action'
import { heroLang, type HeroLang } from '../hero-model/hero-model-view'
import { type ReadingDisplaySubject, useMeasurementText } from '../hero-model/measurement-display'
import { TONE_CLASS } from '../hero-scene/scene-map'
import type { DeviceItemDevice } from './helpers'
import { useRowModel } from './row-models-context'

/** What of a row's device the row value reads. */
export type RowValueDevice = Pick<DeviceItemDevice, 'id' | 'role' | 'display' | 'sourceInfo'>

/**
 * The host's language as the model's `{ en, it }` texts are picked in. A row has no
 * `lang` prop of its own: the ui-text catalogue names its language (`uiLibrary.language`).
 */
function useRowLang(): HeroLang {
  const t = useUiText()
  return heroLang(t('uiLibrary.language', 'en'))
}

export interface RowMeasurementProps {
  readonly measurement: HeroMeasurement
  readonly lang: HeroLang
  readonly subject: ReadingDisplaySubject | null
}

/** A measurement as the row reads it: the value in its tone, then the unit small and muted. */
export function RowMeasurement({ measurement, lang, subject }: RowMeasurementProps): ReactNode {
  const text = useMeasurementText(measurement, lang, subject)
  return (
    <span
      data-testid="row-measurement"
      className="inline-flex min-w-0 items-baseline gap-0.5 whitespace-nowrap text-sm font-semibold tabular-nums"
    >
      <span className={cn('min-w-0 truncate', TONE_CLASS[measurement.tone])}>{text.value}</span>
      {text.unit === null ? null : (
        <span className="text-xs font-normal text-foreground-muted">{text.unit}</span>
      )}
    </span>
  )
}

export interface ModelRowReadingProps {
  readonly device: RowValueDevice
  /** Drawn when the row model carries no measurement for the device. */
  readonly fallback: ReactNode
}

/** A Sensor row's value, from the row model's measurement. */
export function ModelRowReading({ device, fallback }: ModelRowReadingProps): ReactNode {
  const { stage } = useRowModel(device.id)
  const lang = useRowLang()
  if (stage.status === 'pending') return null
  const measurement = stage.status === 'ok' ? stage.row.measurement : undefined
  if (measurement === undefined) return <>{fallback}</>
  return <RowMeasurement measurement={measurement} lang={lang} subject={device} />
}

/** A value written but not yet read back: drawn in place of the model's until it lands. */
interface PendingValue {
  readonly controlId: string
  readonly value: number | string
}

/** One write a row control asks for: the call, and the value to show meanwhile. */
interface RowWrite {
  readonly call: HeroCall
  readonly controlId: string
  readonly value: number | string
}

/** The kinds of control a row edits inline. */
type InlineControl = Extract<HeroControl, { kind: 'number' | 'slider' | 'picker' | 'text' }>

function isInlineControl(control: HeroControl): control is InlineControl {
  return (
    control.kind === 'number' ||
    control.kind === 'slider' ||
    control.kind === 'picker' ||
    control.kind === 'text'
  )
}

interface RowControlProps {
  readonly control: InlineControl
  readonly device: RowValueDevice
  readonly pending: PendingValue | null
  readonly write: (w: RowWrite) => void
}

function withValue(call: HeroCall, valueArg: string, value: number | string): HeroCall {
  return { ...call, args: heroArgsWithValue(call.args, valueArg, value) }
}

/** The row's inline control for one model control. */
function RowControl({ control, device, pending, write }: RowControlProps): ReactNode {
  const t = useUiText()
  const unitPreferences = useUnitPreferences()
  const optimistic = pending?.controlId === control.id ? pending.value : undefined
  switch (control.kind) {
    case 'number':
    case 'slider': {
      const base = typeof optimistic === 'number' ? optimistic : control.value
      if (base === null) return <span className="text-xs text-foreground-subtle">—</span>
      const shown = numericControlDisplay({
        quantity: controlQuantityOf(device.sourceInfo?.quantity),
        display: device.display,
        unitPreferences,
      })
      const unit = shown.unit ?? (control.unit === '' ? undefined : control.unit)
      const step = control.step === null ? undefined : shown.toShown(control.step)
      return (
        <NumericControl
          value={shown.toShown(base)}
          busy={false}
          {...(step === undefined ? {} : { step })}
          {...(control.kind === 'slider'
            ? { min: shown.toShown(control.min), max: shown.toShown(control.max) }
            : {})}
          {...(unit === undefined ? {} : { unit })}
          {...(shown.precision === undefined ? {} : { precision: shown.precision })}
          onCommit={(v) => {
            const value = shown.toBase(v)
            write({
              call: withValue(control.call, control.valueArg, value),
              controlId: control.id,
              value,
            })
          }}
        />
      )
    }
    case 'picker':
      return (
        <Select
          aria-label={t('uiLibrary.controlPanel.value', 'Control value')}
          bare
          wrapperClassName="w-full"
          value={typeof optimistic === 'string' ? optimistic : (control.current ?? '')}
          onChange={(e) => {
            e.stopPropagation()
            const value = e.target.value
            write({
              call: withValue(control.call, control.valueArg, value),
              controlId: control.id,
              value,
            })
          }}
          className="w-full max-w-full min-w-0 truncate rounded bg-transparent px-0.5 py-0.5 text-xs"
        >
          {control.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      )
    case 'text':
      return (
        <TextControl
          value={control.value ?? ''}
          busy={false}
          onCommit={(value) =>
            write({
              call: withValue(control.call, control.valueArg, value),
              controlId: control.id,
              value,
            })
          }
        />
      )
  }
}

export interface ModelRowControlProps {
  readonly device: RowValueDevice
  /** Drawn when the row model offers no inline control (a date, an action, a toggle). */
  readonly fallback: ReactNode
}

/**
 * A Control row's inline control, from the row model's primary control. A write shows
 * its value at once and keeps the control live (no lock while it travels), as the
 * control panel does; a refused write is reported and the read-back value returns.
 */
export function ModelRowControl({ device, fallback }: ModelRowControlProps): ReactNode {
  const t = useUiText()
  const client = useTrpcClient()
  const alert = useAlertIfAvailable()
  const { stage, refetch } = useRowModel(device.id)
  const [pending, setPending] = useState<PendingValue | null>(null)
  const write = useCallback(
    (w: RowWrite): void => {
      setPending({ controlId: w.controlId, value: w.value })
      void (async () => {
        try {
          const bindings = await client.deviceManager.getBindings.query({ deviceId: device.id })
          const nodeId = bindings.entries.find((e) => e.capName === w.call.cap)?.providerNodeId
          await callHeroAction(client, w.call, device.id, nodeId)
          await refetch()
        } catch (err) {
          await alert?.({
            title: t('uiLibrary.controlPanel.setFailed', 'Could not set the value'),
            message: err instanceof Error ? err.message : String(err),
            variant: 'danger',
          })
        } finally {
          setPending((p) => (p?.controlId === w.controlId && p.value === w.value ? null : p))
        }
      })()
    },
    [alert, client, device.id, refetch, t],
  )
  if (stage.status === 'pending') return null
  const primary = stage.status === 'ok' ? stage.row.primary : null
  if (primary === null || !isInlineControl(primary)) return <>{fallback}</>
  return <RowControl control={primary} device={device} pending={pending} write={write} />
}
