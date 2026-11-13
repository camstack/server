/**
 * The trailing value of a Sensor or model-drawn row, drawn from the projected row model
 * (`heroLayout.getRowModels`, D1023) — the same model the device page draws, so the
 * row and the card never disagree on what a device shows or what can be edited.
 *
 *   - a simple sensor: its measurement, through the operator's display resolution
 *     (unit preference, device override, role default, precision);
 *   - a control, button, script or automation device: its primary control and the
 *     extras the model names (a number field with or without bounds, a choice, a text
 *     field, a button, a switch). A number is shown and typed in the display unit and
 *     sent in the base unit, exactly as the control panel does;
 *   - a device with no control the row offers (a date, an update, an event source):
 *     the model's own status word, read-only.
 *
 * While the row model is unanswered nothing is drawn (not-yet-known never looks like
 * "no value", D315); a device the server has no row model for draws nothing either.
 */
import {
  DeviceType,
  heroArgsWithValue,
  type HeroAction,
  type HeroCall,
  type HeroConfirm,
  type HeroControl,
  type HeroMeasurement,
} from '@camstack/types'
import { type ReactNode, useCallback, useState } from 'react'
import { useTrpcClient } from '../../contexts/system-context'
import { useUiText } from '../../contexts/ui-text'
import { useUnitPreferences } from '../../contexts/unit-preferences'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Select } from '../../primitives/select'
import { Switch } from '../../primitives/switch'
import {
  controlQuantityOf,
  numericControlDisplay,
  NumericControl,
  TextControl,
} from '../device-controls/control-panel'
import { useAlertIfAvailable, useConfirmIfAvailable } from '../confirm-dialog'
import { callHeroAction } from '../hero-model/call-hero-action'
import { type HeroLang, pickText } from '../hero-model/hero-model-view'
import {
  type ReadingDisplaySubject,
  useHeroLang,
  useMeasurementText,
} from '../hero-model/measurement-display'
import { TONE_CLASS } from '../hero-scene/scene-map'
import type { DeviceItemDevice } from './helpers'
import { useRowModel } from './row-models-context'

/** What of a row's device the row value reads. */
export type RowValueDevice = Pick<
  DeviceItemDevice,
  'id' | 'role' | 'display' | 'sourceInfo' | 'type'
>


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
  const lang = useHeroLang()
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
type InlineControl = HeroControl

interface RowControlProps {
  readonly control: InlineControl
  readonly device: RowValueDevice
  readonly pending: PendingValue | null
  readonly write: (w: RowWrite) => void
  /** Runs an action that sets no value (a press, a switch); asks first when the action says so. */
  readonly run: (action: HeroAction) => void
  /** Whether a confirmation can be asked here (a dialog provider is mounted). */
  readonly canConfirm: boolean
}

const controlKeyOf = (control: HeroControl): string =>
  control.kind === 'action' ? control.action.id : control.id

function withValue(call: HeroCall, valueArg: string, value: number | string): HeroCall {
  return { ...call, args: heroArgsWithValue(call.args, valueArg, value) }
}

/** The row's inline control for one model control. */
function RowControl({
  control,
  device,
  pending,
  write,
  run,
  canConfirm,
}: RowControlProps): ReactNode {
  const t = useUiText()
  const lang = useHeroLang()
  const unitPreferences = useUnitPreferences()
  const optimistic =
    pending !== null && pending.controlId === controlKeyOf(control) ? pending.value : undefined
  switch (control.kind) {
    case 'action': {
      const { action } = control
      return (
        <Button
          size="sm"
          variant={action.emphasis === 'primary' ? 'primary' : 'outline'}
          disabled={action.confirm !== null && !canConfirm}
          onClick={(e) => {
            e.stopPropagation()
            run(action)
          }}
        >
          {pickText(action.label, lang)}
        </Button>
      )
    }
    case 'toggle':
      return (
        <Switch
          aria-label={pickText(control.label, lang)}
          checked={control.on === true}
          disabled={control.on === null}
          onCheckedChange={(next) => run(next ? control.turnOn : control.turnOff)}
        />
      )
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

/**
 * The words of the confirmation an action asks first (`HeroAction.confirm`): the keys the
 * device card's host uses (`deviceHero.model.confirm.*`), so row and card ask the same thing.
 */
const CONFIRM_COPY: Readonly<
  Record<HeroConfirm, { readonly key: string; readonly title: string; readonly message: string; readonly confirm: string }>
> = {
  'off-while-running': {
    key: 'deviceHero.model.confirmOff',
    title: 'Turn off while running?',
    message: 'The device is running. Cutting its power now interrupts what it is doing.',
    confirm: 'Turn off',
  },
  unlock: {
    key: 'deviceHero.model.confirm.unlock',
    title: 'Unlock?',
    message: 'The lock will open.',
    confirm: 'Unlock',
  },
  install: {
    key: 'deviceHero.model.confirm.install',
    title: 'Install the update?',
    message: 'The device may restart and be unavailable for a while.',
    confirm: 'Install',
  },
  press: {
    key: 'deviceHero.model.confirm.press',
    title: 'Run it now?',
    message: 'The device acts as soon as you confirm.',
    confirm: 'Run',
  },
}

function confirmCopy(
  kind: HeroConfirm,
  t: (key: string, fallback: string) => string,
): { readonly title: string; readonly message: string; readonly confirm: string } {
  const copy = CONFIRM_COPY[kind]
  return {
    title: t(`${copy.key}.title`, copy.title),
    message: t(`${copy.key}.message`, copy.message),
    confirm: t(`${copy.key}.confirm`, copy.confirm),
  }
}

/** The types whose row, with no control to offer, still reads out the model's status word. */
const READOUT_TYPES: ReadonlySet<string> = new Set([
  DeviceType.Control,
  DeviceType.Update,
  DeviceType.EventEmitter,
])

export interface ModelRowControlProps {
  readonly device: RowValueDevice
}

/**
 * A model-drawn row's controls: the row model's primary control then its extras, or
 * the status word when the model offers none. A write shows its value at once and
 * keeps the control live (no lock while it travels), as the control panel does; a
 * refused write is reported and the read-back value returns.
 */
export function ModelRowControl({ device }: ModelRowControlProps): ReactNode {
  const t = useUiText()
  const lang = useHeroLang()
  const client = useTrpcClient()
  const alert = useAlertIfAvailable()
  const confirm = useConfirmIfAvailable()
  const { stage, refetch } = useRowModel(device.id)
  const [pending, setPending] = useState<PendingValue | null>(null)
  const send = useCallback(
    async (call: HeroCall): Promise<void> => {
      try {
        const bindings = await client.deviceManager.getBindings.query({ deviceId: device.id })
        const nodeId = bindings.entries.find((e) => e.capName === call.cap)?.providerNodeId
        await callHeroAction(client, call, device.id, nodeId)
        await refetch()
      } catch (err) {
        await alert?.({
          title: t('uiLibrary.controlPanel.setFailed', 'Could not set the value'),
          message: err instanceof Error ? err.message : String(err),
          variant: 'danger',
        })
      }
    },
    [alert, client, device.id, refetch, t],
  )
  const write = useCallback(
    (w: RowWrite): void => {
      setPending({ controlId: w.controlId, value: w.value })
      void send(w.call).finally(() =>
        setPending((p) => (p?.controlId === w.controlId && p.value === w.value ? null : p)),
      )
    },
    [send],
  )
  const run = useCallback(
    (action: HeroAction): void => {
      void (async () => {
        if (action.confirm !== null) {
          if (confirm === undefined) return
          const copy = confirmCopy(action.confirm, t)
          const ok = await confirm({
            title: copy.title,
            message: copy.message,
            confirmLabel: copy.confirm,
            variant: action.confirm === 'press' ? 'default' : 'danger',
          })
          if (!ok) return
        }
        await send(action.call)
      })()
    },
    [confirm, send, t],
  )
  if (stage.status !== 'ok') return null
  const { primary, extras, statusLine } = stage.row
  const controls = [...(primary === null ? [] : [primary]), ...(extras ?? [])]
  if (controls.length === 0) {
    const head = statusLine[0]
    if (head === undefined || !READOUT_TYPES.has(device.type)) return null
    return (
      <span
        data-testid="row-readout"
        className="min-w-0 truncate text-xs text-foreground-muted"
      >
        {pickText(head, lang)}
      </span>
    )
  }
  return (
    <>
      {controls.map((control) => (
        <RowControl
          key={controlKeyOf(control)}
          control={control}
          device={device}
          pending={pending}
          write={write}
          run={run}
          canConfirm={confirm !== undefined}
        />
      ))}
    </>
  )
}
