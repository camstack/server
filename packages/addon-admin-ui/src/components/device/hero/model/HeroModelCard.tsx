import type {
  HeroAction,
  HeroCall,
  HeroControl,
  HeroModel,
  HeroRow,
  HeroTimedRunSlot,
} from '@camstack/types'
import {
  Badge,
  Button,
  HeroCardA,
  HeroScene,
  Select,
  Slider,
  Switch,
  useDisplayIconResolver,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { badgeVariantOf, type HeroLang, pickText, sceneOf, tilesOf } from './hero-model-view'

/** What the card asks its host to do: run the cap method an action or a control names. */
export interface HeroCardHost {
  readonly lang: HeroLang
  readonly busy: boolean
  /** Runs the call; `confirm` asks first. Resolves when the call settled. */
  readonly run: (call: HeroCall, action: HeroAction | null) => void
}

interface ControlRowProps {
  readonly icon: ReactNode
  readonly status: string | null
  readonly children: ReactNode
  readonly testId: string
}

function ControlRow({ icon, status, children, testId }: ControlRowProps): ReactNode {
  return (
    <div
      data-testid={testId}
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border-subtle bg-background-elevated px-3 py-2"
    >
      <span className="shrink-0 text-foreground-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground-muted">{status ?? ''}</span>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  )
}

function ActionButton({
  action,
  host,
  disabled,
}: {
  readonly action: HeroAction
  readonly host: HeroCardHost
  readonly disabled?: boolean
}): ReactNode {
  return (
    <Button
      size="sm"
      variant={action.emphasis === 'primary' ? 'primary' : 'outline'}
      disabled={host.busy || disabled === true}
      onClick={() => host.run(action.call, action)}
    >
      <IconGlyph name={action.icon} />
      {pickText(action.label, host.lang)}
    </Button>
  )
}

function IconGlyph({ name }: { readonly name: string }): ReactNode {
  const resolve = useDisplayIconResolver()
  const Glyph = resolve(name)
  return Glyph === undefined ? null : <Glyph className="h-4 w-4" aria-hidden />
}

function SliderControl({
  control,
  host,
}: {
  readonly control: Extract<HeroControl, { kind: 'slider' }>
  readonly host: HeroCardHost
}): ReactNode {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? control.value ?? control.min
  const commit = (): void => {
    if (draft === null) return
    host.run(
      {
        ...control.call,
        args: { ...control.call.args, [control.valueArg]: draft },
      },
      null,
    )
    setDraft(null)
  }
  return (
    <div className="flex items-center gap-2">
      <Slider
        aria-label={pickText(control.label, host.lang)}
        className="w-32 sm:w-44"
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
      <span className="w-14 text-right text-xs tabular-nums text-foreground-muted">
        {control.value === null ? '–' : `${String(shown)}${control.unit}`}
      </span>
    </div>
  )
}

function ControlView({
  control,
  host,
}: {
  readonly control: HeroControl
  readonly host: HeroCardHost
}): ReactNode {
  switch (control.kind) {
    case 'action':
      return <ActionButton action={control.action} host={host} />
    case 'toggle':
      return (
        <Switch
          label={pickText(control.label, host.lang)}
          checked={control.on === true}
          disabled={host.busy || control.on === null}
          onCheckedChange={(next) => {
            const action = next ? control.turnOn : control.turnOff
            host.run(action.call, action)
          }}
        />
      )
    case 'slider':
      return <SliderControl control={control} host={host} />
    case 'picker':
      return (
        <Select
          aria-label={pickText(control.label, host.lang)}
          wrapperClassName="relative w-40"
          value={control.current ?? ''}
          disabled={host.busy}
          options={[
            ...(control.current === null ? [{ value: '', label: '–' }] : []),
            ...control.options.map((o) => ({ value: o, label: o })),
          ]}
          onChange={(e) =>
            host.run(
              {
                ...control.call,
                args: {
                  ...control.call.args,
                  [control.valueArg]: e.target.value,
                },
              },
              null,
            )
          }
        />
      )
  }
}

function ModelRow({
  row,
  host,
}: {
  readonly row: HeroRow
  readonly host: HeroCardHost
}): ReactNode {
  return (
    <ControlRow
      testId={`hero-row-${row.id}`}
      icon={<IconGlyph name={row.icon} />}
      status={row.status === null ? null : pickText(row.status, host.lang)}
    >
      {row.controls.map((control, i) => (
        <ControlView key={i} control={control} host={host} />
      ))}
    </ControlRow>
  )
}

function TimedRunRow({
  slot,
  host,
}: {
  readonly slot: HeroTimedRunSlot
  readonly host: HeroCardHost
}): ReactNode {
  const active = slot.activeUntil !== null
  return (
    <ControlRow testId="hero-timed-run" icon={<IconGlyph name={slot.run.icon} />} status={null}>
      {active ? (
        <ActionButton action={slot.cancel} host={host} />
      ) : (
        <ActionButton action={slot.run} host={host} />
      )}
    </ControlRow>
  )
}

function BaseSlotRows({
  model,
  host,
}: {
  readonly model: HeroModel
  readonly host: HeroCardHost
}): ReactNode {
  const gated = new Set(model.gated)
  const { ownPower, timedRun, powerSupply } = model
  return (
    <>
      {ownPower !== null && !gated.has('own-power') ? (
        <ControlRow
          testId="hero-own-power"
          icon={<IconGlyph name={ownPower.turnOn.icon} />}
          status={null}
        >
          <ControlView
            host={host}
            control={{
              kind: 'toggle',
              id: 'own-power',
              label: ownPower.turnOn.label,
              on: ownPower.on,
              turnOn: ownPower.turnOn,
              turnOff: ownPower.turnOff,
            }}
          />
        </ControlRow>
      ) : null}
      {timedRun !== null && !gated.has('timed-run') ? (
        <TimedRunRow slot={timedRun} host={host} />
      ) : null}
      {powerSupply !== null && !gated.has('power-supply') ? (
        <ControlRow
          testId="hero-power-supply"
          icon={<IconGlyph name={powerSupply.powerOn.icon} />}
          status={null}
        >
          <ActionButton
            action={powerSupply.on === true ? powerSupply.powerOff : powerSupply.powerOn}
            host={host}
          />
          <ActionButton
            action={powerSupply.restart}
            host={host}
            disabled={powerSupply.on !== true}
          />
        </ControlRow>
      ) : null}
    </>
  )
}

export interface HeroModelCardProps {
  readonly model: HeroModel
  readonly host: HeroCardHost
  /** The remote button, when the model carries the `remote` slot. */
  readonly remote?: ReactNode
}

/** Layout A, drawn from the hero model and nothing else (D1023). */
export function HeroModelCard({ model, host, remote }: HeroModelCardProps): ReactNode {
  const { lang } = host
  const scene = sceneOf(model)
  const gated = new Set(model.gated)
  return (
    <HeroCardA
      title={model.name}
      chips={
        <>
          <Badge variant={badgeVariantOf(model.look.tone)} size="sm">
            {pickText(model.title, lang)}
          </Badge>
          {model.facts.map((fact) => (
            <Badge key={fact.id} variant={badgeVariantOf(fact.tone)} size="sm">
              {pickText(fact.text, lang)}
            </Badge>
          ))}
        </>
      }
      scene={
        <HeroScene
          {...scene}
          leftTiles={tilesOf(model.sideTiles.left, lang)}
          rightTiles={tilesOf(model.sideTiles.right, lang)}
        >
          {model.background.kind === 'artwork' ? (
            <img
              src={model.background.url}
              alt=""
              className="size-24 rounded-lg border border-border object-cover"
            />
          ) : (
            <span className="text-foreground [&>svg]:h-8 [&>svg]:w-8">
              <IconGlyph name={model.look.icon} />
            </span>
          )}
        </HeroScene>
      }
      rows={
        <>
          <BaseSlotRows model={model} host={host} />
          {model.rows
            .filter((row) => !gated.has(row.id))
            .map((row) => (
              <ModelRow key={row.id} row={row} host={host} />
            ))}
        </>
      }
      footAction={model.remote !== null && !gated.has('remote') ? remote : undefined}
    />
  )
}
