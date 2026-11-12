/**
 * The trailing value of a Sensor or Control row, drawn from the projected row model
 * (`heroLayout.getRowModels`, D1023) — the same model the device page draws, so the
 * row and the card never disagree.
 *
 *   - a simple sensor: its measurement's value, the unit small and muted;
 *   - a control device: its primary control (a number field, with or without bounds,
 *     a choice, a text field).
 *
 * While the row model is unanswered nothing is drawn (not-yet-known never looks like
 * "no value", D315). When the server has no row model for the device, or the model
 * carries nothing for the row (a sensor with two readings, a date control), the
 * caller's `fallback` — today's atom — draws instead.
 */
import {
  heroArgsWithValue,
  type HeroCall,
  type HeroControl,
  type HeroMeasurement,
  type HeroRowModel,
} from '@camstack/types'
import { type ReactNode, useCallback, useState } from 'react'
import { useTrpcClient } from '../../contexts/system-context'
import { useUiText } from '../../contexts/ui-text'
import {
  useDeviceManagerGetBindings,
  useHeroLayoutGetRowModels,
} from '../../generated/system-hooks'
import { cn } from '../../lib/cn'
import { Select } from '../../primitives/select'
import { NumericControl, TextControl } from '../device-controls/control-panel'
import { useAlertIfAvailable } from '../confirm-dialog'
import { callHeroAction } from '../hero-model/call-hero-action'
import { heroLang, type HeroLang, pickText } from '../hero-model/hero-model-view'
import { TONE_CLASS } from '../hero-scene/scene-map'
import { useHeroLiveRefresh } from '../hero-model/use-hero-live-refresh'

type RowStage =
  | { readonly status: 'pending' }
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly row: HeroRowModel }

/** The device's row model, re-read when any of its slices pushes. */
function useRowModel(deviceId: number): {
  readonly stage: RowStage
  readonly refetch: () => unknown
} {
  const q = useHeroLayoutGetRowModels({ deviceIds: [deviceId], canActuate: true })
  useHeroLiveRefresh(deviceId, q.refetch)
  if (q.status === 'pending') return { stage: { status: 'pending' }, refetch: q.refetch }
  const row = q.status === 'success' ? q.data[0] : null
  return {
    stage: row === null || row === undefined ? { status: 'absent' } : { status: 'ok', row },
    refetch: q.refetch,
  }
}

/**
 * The host's language as the model's `{ en, it }` texts are picked in. A row has no
 * `lang` prop of its own: the ui-text catalogue names its language (`uiLibrary.language`).
 */
function useRowLang(): HeroLang {
  const t = useUiText()
  return heroLang(t('uiLibrary.language', 'en'))
}

/** A measurement as the row reads it: the value, then the unit small and muted. */
export function RowMeasurement({
  measurement,
  lang,
}: {
  readonly measurement: HeroMeasurement
  readonly lang: HeroLang
}): ReactNode {
  return (
    <span
      data-testid="row-measurement"
      className="inline-flex min-w-0 items-baseline gap-0.5 whitespace-nowrap text-sm font-semibold tabular-nums"
    >
      <span className={cn('min-w-0 truncate', TONE_CLASS[measurement.tone])}>
        {pickText(measurement.value, lang)}
      </span>
      {measurement.unit === null ? null : (
        <span className="text-xs font-normal text-foreground-muted">{measurement.unit}</span>
      )}
    </span>
  )
}

export interface ModelRowReadingProps {
  readonly deviceId: number
  /** Drawn when the row model carries no measurement for the device. */
  readonly fallback: ReactNode
}

/** A Sensor row's value, from the row model's measurement. */
export function ModelRowReading({ deviceId, fallback }: ModelRowReadingProps): ReactNode {
  const { stage } = useRowModel(deviceId)
  const lang = useRowLang()
  if (stage.status === 'pending') return null
  const measurement = stage.status === 'ok' ? stage.row.measurement : undefined
  if (measurement === undefined) return <>{fallback}</>
  return <RowMeasurement measurement={measurement} lang={lang} />
}

/** The row's inline control for one model control; `null` for a kind a row does not edit inline. */
function RowControl({
  control,
  busy,
  run,
}: {
  readonly control: HeroControl
  readonly busy: boolean
  readonly run: (call: HeroCall) => void
}): ReactNode {
  const t = useUiText()
  const withValue = (call: HeroCall, valueArg: string, value: number | string): HeroCall => ({
    ...call,
    args: heroArgsWithValue(call.args, valueArg, value),
  })
  switch (control.kind) {
    case 'number':
    case 'slider':
      return control.value === null ? (
        <span className="text-xs text-foreground-subtle">—</span>
      ) : (
        <NumericControl
          value={control.value}
          busy={busy}
          {...(control.step === null ? {} : { step: control.step })}
          {...(control.kind === 'slider' ? { min: control.min, max: control.max } : {})}
          {...(control.unit === '' ? {} : { unit: control.unit })}
          onCommit={(v) => run(withValue(control.call, control.valueArg, v))}
        />
      )
    case 'picker':
      return (
        <Select
          aria-label={t('uiLibrary.controlPanel.value', 'Control value')}
          bare
          wrapperClassName="w-full"
          disabled={busy}
          value={control.current ?? ''}
          onChange={(e) => {
            e.stopPropagation()
            run(withValue(control.call, control.valueArg, e.target.value))
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
          busy={busy}
          onCommit={(v) => run(withValue(control.call, control.valueArg, v))}
        />
      )
    case 'action':
    case 'toggle':
      return null
  }
}

export interface ModelRowControlProps {
  readonly deviceId: number
  /** Drawn when the row model offers no inline control (a date control is read-only). */
  readonly fallback: ReactNode
}

/** A Control row's inline control, from the row model's primary control. */
export function ModelRowControl({ deviceId, fallback }: ModelRowControlProps): ReactNode {
  const t = useUiText()
  const client = useTrpcClient()
  const alert = useAlertIfAvailable()
  const bindings = useDeviceManagerGetBindings({ deviceId })
  const { stage, refetch } = useRowModel(deviceId)
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    (call: HeroCall): void => {
      void (async () => {
        const nodeId = bindings.data?.entries.find((e) => e.capName === call.cap)?.providerNodeId
        setBusy(true)
        try {
          await callHeroAction(client, call, deviceId, nodeId)
          await refetch()
        } catch (err) {
          await alert?.({
            title: t('uiLibrary.controlPanel.setFailed', 'Could not set the value'),
            message: err instanceof Error ? err.message : String(err),
            variant: 'danger',
          })
        } finally {
          setBusy(false)
        }
      })()
    },
    [alert, bindings.data, client, deviceId, refetch, t],
  )
  if (stage.status === 'pending') return null
  const primary = stage.status === 'ok' ? stage.row.primary : null
  if (primary === null) return <>{fallback}</>
  return <RowControl control={primary} busy={busy} run={run} />
}
