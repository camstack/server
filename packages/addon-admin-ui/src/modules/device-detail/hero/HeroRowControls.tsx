import {
  heroArgsWithValue,
  REMOTE_OPEN_ACTION_ID,
  type HeroAction,
  type HeroCall,
  type HeroControl,
  type HeroRowModel,
} from '@camstack/types'
import {
  IconButton,
  Select,
  Slider,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useDisplayIconResolver,
} from '@camstack/ui-library'
import { Minus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type HeroLang, pickText } from './hero-model-view'

/** What a device row asks its host to do. */
export interface HeroRowHost {
  readonly lang: HeroLang
  readonly busy: boolean
  /** Runs the cap method a control names. */
  readonly run: (call: HeroCall, action: HeroAction | null) => void
  /** Opens the device's remote. Absent: the remote icon is not drawn. */
  readonly openRemote?: () => void
}

function RowAction({
  action,
  host,
}: {
  readonly action: HeroAction
  readonly host: HeroRowHost
}): ReactNode {
  const resolve = useDisplayIconResolver()
  const label = pickText(action.label, host.lang)
  const opensRemote = action.id === REMOTE_OPEN_ACTION_ID
  if (opensRemote && host.openRemote === undefined) return null
  return (
    <Tooltip className="inline-block">
      <TooltipTrigger>
        <IconButton
          aria-label={label}
          icon={resolve(action.icon) ?? Minus}
          size="sm"
          variant={action.emphasis === 'primary' ? 'primary' : 'outline'}
          disabled={opensRemote ? false : host.busy}
          data-testid={`row-action-${action.id}`}
          onClick={() => (opensRemote ? host.openRemote?.() : host.run(action.call, action))}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function RowSlider({
  control,
  host,
}: {
  readonly control: Extract<HeroControl, { kind: 'slider' }>
  readonly host: HeroRowHost
}): ReactNode {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? control.value ?? control.min
  const commit = (): void => {
    if (draft === null) return
    host.run(
      { ...control.call, args: heroArgsWithValue(control.call.args, control.valueArg, draft) },
      null,
    )
    setDraft(null)
  }
  return (
    <div className="flex w-32 items-center gap-2" data-testid={`row-slider-${control.id}`}>
      <Slider
        aria-label={pickText(control.label, host.lang)}
        className="min-w-0 flex-1"
        min={control.min}
        max={control.max}
        step={control.step}
        value={shown}
        disabled={host.busy || control.value === null}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="w-10 text-right text-xs tabular-nums text-foreground-muted">
        {control.value === null ? '–' : `${String(shown)}${control.unit}`}
      </span>
    </div>
  )
}

function RowPicker({
  control,
  host,
}: {
  readonly control: Extract<HeroControl, { kind: 'picker' }>
  readonly host: HeroRowHost
}): ReactNode {
  const optionLabel = (o: string): string => {
    const named = control.optionLabels?.[o]
    return named === undefined ? o : pickText(named, host.lang)
  }
  return (
    <Select
      aria-label={pickText(control.label, host.lang)}
      wrapperClassName="relative w-28 max-w-full"
      value={control.current ?? ''}
      disabled={host.busy}
      options={[
        ...(control.current === null ? [{ value: '', label: '–' }] : []),
        ...control.options.map((o) => ({ value: o, label: optionLabel(o) })),
      ]}
      onChange={(e) =>
        host.run(
          {
            ...control.call,
            args: heroArgsWithValue(control.call.args, control.valueArg, e.target.value),
          },
          null,
        )
      }
    />
  )
}

function RowControl({
  control,
  host,
}: {
  readonly control: HeroControl
  readonly host: HeroRowHost
}): ReactNode {
  switch (control.kind) {
    case 'action':
      return <RowAction action={control.action} host={host} />
    case 'toggle':
      return (
        <Switch
          aria-label={pickText(control.label, host.lang)}
          checked={control.on === true}
          disabled={host.busy || control.on === null}
          onCheckedChange={(next) => {
            const action = next ? control.turnOn : control.turnOff
            host.run(action.call, action)
          }}
        />
      )
    case 'slider':
      return <RowSlider control={control} host={host} />
    case 'picker':
      return <RowPicker control={control} host={host} />
  }
}

const controlKey = (c: HeroControl): string => (c.kind === 'action' ? c.action.id : c.id)

/** The inline controls of a device row: `primary`, then its `extras` in order. */
export function HeroRowControls({
  row,
  host,
}: {
  readonly row: HeroRowModel
  readonly host: HeroRowHost
}): ReactNode {
  const controls = [...(row.primary === null ? [] : [row.primary]), ...(row.extras ?? [])]
  if (controls.length === 0) return null
  return (
    <div className="flex items-center gap-2" data-testid="hero-row-controls">
      {controls.map((control) => (
        <RowControl key={controlKey(control)} control={control} host={host} />
      ))}
    </div>
  )
}
