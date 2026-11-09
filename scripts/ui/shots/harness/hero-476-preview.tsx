/**
 * Mockups for planning#476: the heat pump ("Pompa di calore") and the energy system
 * ("Impianto") hero cards, drawn with the REAL layout-A kit (`HeroCardA`, `HeroScene`,
 * `HeroRowLine`, `HeroSegmented`, `HeroProgressBar`, `DeviceRow`, `Badge`) exactly the way
 * `HeroModelCard` composes them. Mockup-only: no device type or cap exists yet, so the
 * model is not built; the two centre drawings (heat pump unit, energy flow) are drawn here
 * in the style of `scene-art-home.tsx` (BODY fill/stroke, `currentColor` accent, the
 * `art-*` keyframes of the library). `ui:shots` mounts it for `/hero-476-preview?view=...`
 * with views hp | energy | customize | container.
 */
import {
  Badge,
  Button,
  DeviceRow,
  DeviceSelectField,
  HeroCardA,
  HeroProgressBar,
  HeroRowLine,
  HeroScene,
  HeroSegmented,
  PrimaryChildPicker,
  SectionCard,
  Select,
  SettingRow,
  Switch,
  ThemeProvider,
  TrpcClientProvider,
  trpc,
} from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  BatteryCharging,
  Droplets,
  Flame,
  House,
  Settings2,
  Sun,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { type ReactElement, type ReactNode, useState } from 'react'
import { fakeClient } from './stubs/transport'

const BODY = 'fill-background-elevated stroke-border'

/** Italian number: decimal comma, fixed digits. */
const n = (v: number, digits = 1): string => v.toFixed(digits).replace('.', ',')

// ---------------------------------------------------------------- heat pump art

/**
 * The outdoor unit: housing, a grille with the fan (spins while the compressor runs, like
 * the pump of the fountain), warm air rising off the top (`art-heat`), and the water
 * circuit leaving the side (`art-stream`, warm supply over a cool return).
 */
function HeatPumpArt({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 170" aria-hidden="true" className="h-36 w-auto max-w-full">
      <rect x="28" y="26" width="112" height="128" rx="14" className={BODY} strokeWidth="2" />
      <circle cx="46" cy="42" r="3.5" className="fill-current" />
      <rect x="56" y="38" width="40" height="8" rx="4" className="fill-surface-hover" />
      <circle cx="84" cy="98" r="44" className="fill-surface stroke-border" strokeWidth="3" />
      <circle cx="84" cy="98" r="36" className="fill-none stroke-border" strokeWidth="1.5" />
      <g className={running ? 'art-spin-fast' : undefined}>
        <path
          d="M84 98 q-8 -18 0 -32 q10 12 0 32z M84 98 q18 -8 32 0 q-12 10 -32 0z M84 98 q8 18 0 32 q-10 -12 0 -32z M84 98 q-18 8 -32 0 q12 -10 32 0z"
          className="fill-current opacity-80"
        />
        <circle cx="84" cy="98" r="5" className="fill-background stroke-border" strokeWidth="2" />
      </g>
      {running ? (
        <g className="stroke-current" fill="none" strokeWidth="2" strokeLinecap="round">
          <path className="art-heat" d="M52 22 q4 -6 0 -12 q-4 -6 0 -12" />
          <path className="art-heat" d="M84 22 q4 -6 0 -12 q-4 -6 0 -12" />
          <path className="art-heat" d="M116 22 q4 -6 0 -12 q-4 -6 0 -12" />
        </g>
      ) : null}
      <path d="M140 70 H176 V150" className="fill-none stroke-border" strokeWidth="7" />
      <path d="M140 118 H160 V150" className="fill-none stroke-border" strokeWidth="7" />
      <path
        d="M140 70 H176 V150"
        className={running ? 'art-stream stroke-warning' : 'stroke-warning opacity-30'}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M160 150 V118 H140"
        className={running ? 'art-stream stroke-info' : 'stroke-info opacity-30'}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="176" cy="154" r="4" className="fill-success" />
    </svg>
  )
}

// ----------------------------------------------------------------- energy art

type FlowTone = 'warning' | 'success' | 'info' | 'primary'

const FLOW_STROKE: Readonly<Record<FlowTone, string>> = {
  warning: 'stroke-warning',
  success: 'stroke-success',
  info: 'stroke-info',
  primary: 'stroke-primary',
}
const FLOW_FILL: Readonly<Record<FlowTone, string>> = {
  warning: 'fill-warning',
  success: 'fill-success',
  info: 'fill-info',
  primary: 'fill-primary',
}
const FLOW_TEXT: Readonly<Record<FlowTone, string>> = {
  warning: 'text-warning',
  success: 'text-success',
  info: 'text-info',
  primary: 'text-primary',
}

/** Below this a flow is "none": the link is drawn still and the value reads as 0. */
const IDLE_W = 20

interface Pt {
  readonly x: number
  readonly y: number
}

interface Link {
  /** Path from the SOURCE to the sink: the dashes travel along it. */
  readonly from: Pt
  readonly to: Pt
  readonly watts: number
  readonly tone: FlowTone
  /** Label shift along the link, 0..1. */
  readonly at?: number
}

function shorten(from: Pt, to: Pt, by: number): { a: Pt; b: Pt } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  return {
    a: { x: from.x + ux * by, y: from.y + uy * by },
    b: { x: to.x - ux * by, y: to.y - uy * by },
  }
}

function wattsText(w: number): string {
  const a = Math.abs(w)
  return a >= 1000 ? `${n(a / 1000, 2)} kW` : `${String(Math.round(a))} W`
}

/** One connection: a still track, the animated flow over it, an arrow head and its power. */
function FlowLink({ link, r }: { readonly link: Link; readonly r: number }): ReactNode {
  const { a, b } = shorten(link.from, link.to, r)
  const active = Math.abs(link.watts) >= IDLE_W
  const at = link.at ?? 0.5
  const mx = a.x + (b.x - a.x) * at
  const my = a.y + (b.y - a.y) * at
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  const ax = a.x + (b.x - a.x) * 0.78
  const ay = a.y + (b.y - a.y) * 0.78
  const label = active ? wattsText(link.watts) : '0 W'
  const width = label.length * 6.4 + 10
  return (
    <g>
      <path
        d={`M${String(a.x)} ${String(a.y)} L${String(b.x)} ${String(b.y)}`}
        className="fill-none stroke-border"
        strokeWidth="5"
        strokeLinecap="round"
      />
      {active ? (
        <>
          <path
            d={`M${String(a.x)} ${String(a.y)} L${String(b.x)} ${String(b.y)}`}
            className={`art-stream fill-none ${FLOW_STROKE[link.tone]}`}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M-5 -4 L4 0 L-5 4z"
            transform={`translate(${String(ax)} ${String(ay)}) rotate(${String(angle)})`}
            className={FLOW_FILL[link.tone]}
          />
        </>
      ) : null}
      <rect
        x={mx - width / 2}
        y={my - 9}
        width={width}
        height="18"
        rx="9"
        className="fill-surface stroke-border"
        strokeWidth="1"
      />
      <text
        x={mx}
        y={my + 4}
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        className={active ? 'fill-foreground' : 'fill-foreground-subtle'}
      >
        {label}
      </text>
    </g>
  )
}

interface NodeProps {
  readonly at: Pt
  readonly r: number
  readonly icon: LucideIcon
  readonly tone: FlowTone | null
  readonly caption: string
  readonly captionAbove?: boolean
}

/** A circle in the machine style (`surface` + `border`), ringed in the tone while it moves power. */
function FlowNode({ at, r, icon: Icon, tone, caption, captionAbove }: NodeProps): ReactNode {
  const size = r * 0.95
  return (
    <g className={tone === null ? 'text-foreground-muted' : FLOW_TEXT[tone]}>
      <circle
        cx={at.x}
        cy={at.y}
        r={r}
        className={`fill-surface ${tone === null ? 'stroke-border' : 'stroke-current'}`}
        strokeWidth="2"
      />
      <Icon
        x={at.x - size / 2}
        y={at.y - size / 2}
        width={size}
        height={size}
        className="stroke-current"
        aria-hidden
      />
      <text
        x={at.x}
        y={captionAbove === true ? at.y - r - 6 : at.y + r + 13}
        textAnchor="middle"
        fontSize="10"
        className="fill-foreground-muted"
      >
        {caption}
      </text>
    </g>
  )
}

export interface EnergyFlows {
  /** PV production, W (>= 0). */
  readonly pv: number
  /** Battery, W: positive charges it, negative discharges it. */
  readonly battery: number
  /** Grid, W: positive imports, negative exports. */
  readonly grid: number
  /** House consumption, W. */
  readonly house: number
  /** The linked heat pump's live power, W; `null` = nothing linked. */
  readonly heatPump: number | null
  readonly soc: number
}

const POS = {
  pv: { x: 58, y: 44 },
  grid: { x: 302, y: 44 },
  battery: { x: 58, y: 150 },
  house: { x: 180, y: 98 },
  heatPump: { x: 302, y: 150 },
} as const

/** PV / battery / grid around the house, the heat pump as a small extra node on the load side. */
function EnergyFlowArt({ flows }: { readonly flows: EnergyFlows }): ReactNode {
  const { pv, battery, grid, heatPump } = flows
  const R = 22
  const links: Link[] = [
    { from: POS.pv, to: POS.house, watts: pv, tone: 'warning', at: 0.45 },
    grid >= 0
      ? { from: POS.grid, to: POS.house, watts: grid, tone: 'info', at: 0.45 }
      : { from: POS.house, to: POS.grid, watts: grid, tone: 'success', at: 0.55 },
    battery >= 0
      ? { from: POS.house, to: POS.battery, watts: battery, tone: 'success', at: 0.55 }
      : { from: POS.battery, to: POS.house, watts: battery, tone: 'success', at: 0.45 },
    ...(heatPump === null
      ? []
      : [{ from: POS.house, to: POS.heatPump, watts: heatPump, tone: 'warning', at: 0.55 } as Link]),
  ]
  return (
    <svg viewBox="0 0 360 196" aria-hidden="true" className="h-full w-full max-w-[420px]">
      {links.map((link, i) => (
        <FlowLink key={i} link={link} r={link.to === POS.house || link.from === POS.house ? R : R} />
      ))}
      <FlowNode
        at={POS.pv}
        r={R}
        icon={Sun}
        tone={pv >= IDLE_W ? 'warning' : null}
        caption="Fotovoltaico"
        captionAbove
      />
      <FlowNode
        at={POS.grid}
        r={R}
        icon={Zap}
        tone={Math.abs(grid) >= IDLE_W ? (grid >= 0 ? 'info' : 'success') : null}
        caption={Math.abs(grid) < IDLE_W ? 'Rete' : grid >= 0 ? 'Rete · import' : 'Rete · export'}
        captionAbove
      />
      <FlowNode
        at={POS.battery}
        r={R}
        icon={BatteryCharging}
        tone={Math.abs(battery) >= IDLE_W ? 'success' : null}
        caption={`Batteria ${n(flows.soc)} %`}
      />
      <FlowNode at={POS.house} r={26} icon={House} tone="primary" caption="Casa" />
      {heatPump === null ? null : (
        <FlowNode
          at={POS.heatPump}
          r={16}
          icon={Flame}
          tone={heatPump >= IDLE_W ? 'warning' : null}
          caption="Pompa di calore"
        />
      )}
    </svg>
  )
}

// ----------------------------------------------------------------- shared bits

const noop = (): void => undefined

function CircuitValue({
  icon: Icon,
  tone,
  children,
}: {
  readonly icon: LucideIcon
  readonly tone: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className={`h-4 w-4 shrink-0 ${tone}`} aria-hidden />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

function HeatingCircuitRow({
  label,
  target,
  mode,
  note,
}: {
  readonly label: string
  readonly target: number
  readonly mode: 'auto' | 'manual'
  readonly note?: string
}): ReactNode {
  return (
    <HeroRowLine
      testId="circuit-row"
      label={label}
      actions={
        <HeroSegmented
          label={label}
          tone="warning"
          value={mode}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'manual', label: 'Manuale' },
          ]}
          onChange={noop}
        />
      }
    >
      <CircuitValue icon={Flame} tone="text-warning">
        {n(target)} °C{note === undefined ? '' : ` · ${note}`}
      </CircuitValue>
    </HeroRowLine>
  )
}

// ------------------------------------------------------------- the heat pump

/** The "Pompa di calore" hero, with the operator's real values (Compress CS5800iAW via HomeCom). */
export function HeatPumpHero({ title = 'Pompa di calore' }: { readonly title?: string }): ReactNode {
  const cop = 74.16 / 30.46
  return (
    <HeroCardA
      title={title}
      chips={
        <>
          <Badge variant="neutral" size="sm">
            HomeCom
          </Badge>
          <Badge variant="warning" size="sm">
            Compressore 18 %
          </Badge>
        </>
      }
      scene={
        <HeroScene
          scene="heater"
          state="on"
          caption="ACQUA CALDA · in carica"
          leftTiles={[
            { label: 'Mandata', value: '59,7 °C' },
            { label: 'Ritorno', value: '52,3 °C' },
          ]}
          rightTiles={[
            { label: 'Esterna', value: '8,8 °C' },
            { label: 'Pressione', value: '1,8 bar' },
          ]}
        >
          <span className="text-warning">
            <HeatPumpArt running />
          </span>
        </HeroScene>
      }
      rows={
        <>
          <HeatingCircuitRow label="Circuito 1" target={30} mode="manual" />
          <HeatingCircuitRow label="Circuito 2" target={30} mode="auto" />
          <HeroRowLine
            testId="circuit-row"
            label="Acqua calda"
            actions={
              <Select
                aria-label="Acqua calda"
                wrapperClassName="relative w-28 max-w-full"
                value="eco-plus"
                options={[
                  { value: 'eco-plus', label: 'Eco+' },
                  { value: 'eco', label: 'Eco' },
                  { value: 'comfort', label: 'Comfort' },
                ]}
                onChange={noop}
              />
            }
          >
            <CircuitValue icon={Droplets} tone="text-info">
              {n(51.1)} °C <span className="text-xs text-foreground-muted">(43,3–60)</span>
            </CircuitValue>
          </HeroRowLine>
          <HeroRowLine testId="circuit-row" label="Solare">
            <CircuitValue icon={Sun} tone="text-warning">
              Coll. {n(28)} · serb. {n(28)} °C ·{' '}
              <span className="text-foreground-muted">resa {n(0)}</span>
            </CircuitValue>
          </HeroRowLine>
          <HeroRowLine testId="energy-row" label="Oggi">
            <div className="text-xs">
              Prodotta {n(74.16, 2)} kWh · assorbita {n(30.46, 2)} kWh ·{' '}
              <span className="font-semibold text-success">COP {n(cop)}</span>
            </div>
          </HeroRowLine>
          <HeroRowLine
            label="Silenzioso"
            actions={<Switch aria-label="Silenzioso" checked={false} onCheckedChange={noop} />}
          />
          <HeroRowLine
            label="Resistenza"
            actions={<Switch aria-label="Resistenza" checked={false} onCheckedChange={noop} />}
          />
          <HeroRowLine
            label="Assenza"
            actions={
              <Button size="sm" variant="outline" onClick={noop}>
                Imposta vacanza
              </Button>
            }
          >
            <div className="text-xs">Nessuna vacanza · assenza off</div>
          </HeroRowLine>
        </>
      }
      footChips={
        <>
          <Badge variant="neutral" size="sm">
            494 avviamenti
          </Badge>
          <Badge variant="neutral" size="sm">
            24 098 h
          </Badge>
        </>
      }
      footAction={
        <Button size="sm" variant="outline" onClick={noop}>
          Storico
        </Button>
      }
    />
  )
}

// ------------------------------------------------------------ the energy system

/** The real moment of the fixture: PV 1234 W, battery 98,9 % charging 339 W, grid 5 W, house 895 W. */
const NOW_FLOWS: EnergyFlows = { pv: 1234, battery: 339, grid: 5, house: 895, heatPump: null, soc: 98.9 }
/** Illustrative, to show the opposite directions: night, battery discharging, grid importing. */
const NIGHT_FLOWS: EnergyFlows = { pv: 0, battery: -1180, grid: 412, house: 1592, heatPump: 2991, soc: 61.4 }

/** The "Impianto" hero; `heatPump` is the live power of a LINKED heat pump, `null` when not linked. */
export function EnergyHero({
  flows,
  caption,
  title = 'Impianto',
}: {
  readonly flows: EnergyFlows
  readonly caption: string
  readonly title?: string
}): ReactNode {
  return (
    <HeroCardA
      title={title}
      chips={
        <>
          <Badge variant="neutral" size="sm">
            Enpal
          </Badge>
          <Badge variant="success" size="sm">
            Batteria {n(flows.soc)} %
          </Badge>
        </>
      }
      scene={
        <HeroScene
          scene="plug"
          state="on"
          caption={caption}
          className="h-56"
          rightTiles={undefined}
        >
          <EnergyFlowArt flows={flows} />
        </HeroScene>
      }
      rows={
        <>
          <HeroRowLine
            label="Modalità"
            actions={
              <Select
                aria-label="Modalità"
                wrapperClassName="relative w-40 max-w-full"
                value="self"
                options={[
                  { value: 'self', label: 'Autoconsumo' },
                  { value: 'charge', label: 'Carica forzata' },
                  { value: 'hold', label: 'Mantieni' },
                ]}
                onChange={noop}
              />
            }
          />
          <HeroRowLine
            label="Batteria"
            actions={<span className="text-xs tabular-nums text-foreground-muted">15,2 kWh</span>}
          >
            <HeroProgressBar value={flows.soc / 100} label="Batteria" tone="success" />
          </HeroRowLine>
          <HeroRowLine label="Oggi">
            <div className="text-xs">
              FV {n(4.0)} · consumo {n(3.6)} · import {n(0.8)} · export {n(1.1)} kWh
            </div>
          </HeroRowLine>
        </>
      }
      footAction={
        <Button size="sm" variant="outline" onClick={noop}>
          Storico
        </Button>
      }
    />
  )
}

// ------------------------------------------------------------------ customize

/** The Customize section of the energy-system device: the heat pump link, picked by the operator. */
function CustomizeCard({ linked }: { readonly linked: boolean }): ReactNode {
  const [value, setValue] = useState(linked ? '2301' : '')
  return (
    <SectionCard
      headingId={`customize-${linked ? 'on' : 'off'}`}
      title="Personalizza"
      icon={Settings2}
    >
      <div className="flex flex-col gap-1 p-3">
        <SettingRow label="Pompa di calore">
          <DeviceSelectField
            field={{
              type: 'device-select',
              key: 'heatPump',
              label: '',
              deviceFilter: { caps: ['heat-pump'], excludeTypes: ['container'] },
            }}
            value={value}
            onChange={(v) => setValue(String(v))}
          />
        </SettingRow>
        <p className="px-1 text-xs text-foreground-muted">
          La pompa di calore scelta compare come utenza nel flusso dell&apos;impianto. Non viene
          collegata da sola.
        </p>
      </div>
    </SectionCard>
  )
}

// ------------------------------------------------------------------ container

const HP_CHILDREN = [
  { id: 2301, stableId: 'hp', type: 'heater', name: 'Pompa di calore' },
  { id: 2302, stableId: 'hc1', type: 'thermostat', name: 'Circuito 1' },
  { id: 2303, stableId: 'hc2', type: 'thermostat', name: 'Circuito 2' },
  { id: 2304, stableId: 'dhw1', type: 'water_heater', name: 'Acqua calda' },
  { id: 2305, stableId: 'sc1', type: 'sensor', name: 'Solare' },
] as const

const EN_CHILDREN = [
  { id: 2401, stableId: 'sys', type: 'sensor', name: 'Impianto' },
  { id: 2402, stableId: 'bat', type: 'sensor', name: 'Batteria' },
  { id: 2403, stableId: 'inv', type: 'sensor', name: 'Inverter' },
  { id: 2404, stableId: 'grid', type: 'sensor', name: 'Rete' },
] as const

/** A container as the device list draws it: the row carries the PRIMARY child's mini scene. */
function ContainerList(): ReactNode {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <DeviceRow
        scene={{ scene: 'heater', state: 'on' }}
        name="Bosch Compress CS5800iAW"
        status="Acqua calda · compressore 18 %"
        control={<Badge variant="warning">59,7 °C</Badge>}
        fact={<Badge variant="neutral">2,99 kW</Badge>}
      />
      <DeviceRow
        scene={{ scene: 'plug', state: 'on' }}
        name="Enpal Box + Sungrow SH12T"
        status="FV 1,23 kW · batteria 98,9 % in carica"
        control={<Badge variant="success">98,9 %</Badge>}
        fact={<Badge variant="neutral">1,23 kW</Badge>}
      />
    </div>
  )
}

/** The container detail: the primary child's hero, the "primary child" picker row, the children. */
function ContainerDetail({
  name,
  hero,
  kids,
  childScenes,
}: {
  readonly name: string
  readonly hero: ReactNode
  readonly kids: readonly { id: number; stableId: string; type: string; name: string }[]
  readonly childScenes: readonly { scene: 'heater' | 'thermostat' | 'plug' | 'sensor-sparkline'; status: string }[]
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="px-1 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
        {name}
      </div>
      {hero}
      <SectionCard headingId={`info-${name}`} title="Informazioni">
        <div className="p-3">
          <SettingRow label="Dispositivo principale">
            <PrimaryChildPicker
              childrenList={kids}
              selectedId={kids[0]?.id ?? 0}
              onSetPrimary={noop}
            />
          </SettingRow>
        </div>
      </SectionCard>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {kids.map((k, i) => (
          <DeviceRow
            key={k.id}
            scene={{
              scene: childScenes[i]?.scene ?? 'generic',
              state: i === 0 ? 'on' : 'idle',
            }}
            name={k.name}
            status={childScenes[i]?.status}
          />
        ))}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------- page

const CELL = 'w-[416px] max-w-full'

function Cell({ id, children }: { readonly id: string; readonly children: ReactNode }): ReactNode {
  return (
    <div data-cell={id} className={CELL}>
      {children}
    </div>
  )
}

function View({ view }: { readonly view: string }): ReactNode {
  const linked: EnergyFlows = { ...NOW_FLOWS, heatPump: 2991 }
  if (view === 'hp') {
    return (
      <Cell id="hp">
        <HeatPumpHero />
      </Cell>
    )
  }
  if (view === 'energy') {
    return (
      <>
        <Cell id="energy-now">
          <EnergyHero flows={NOW_FLOWS} caption="AUTOCONSUMO · batteria in carica" />
        </Cell>
        <Cell id="energy-night">
          <EnergyHero
            flows={NIGHT_FLOWS}
            caption="AUTOCONSUMO · batteria in scarica · rete in import"
          />
        </Cell>
      </>
    )
  }
  if (view === 'customize') {
    return (
      <>
        <div className="flex w-[416px] max-w-full flex-col gap-3" data-cell="customize-off">
          <div>
            <CustomizeCard linked={false} />
          </div>
          <div>
            <EnergyHero flows={NOW_FLOWS} caption="AUTOCONSUMO · batteria in carica" />
          </div>
        </div>
        <div className="flex w-[416px] max-w-full flex-col gap-3" data-cell="customize-on">
          <div>
            <CustomizeCard linked />
          </div>
          <div>
            <EnergyHero flows={linked} caption="AUTOCONSUMO · batteria in carica" />
          </div>
        </div>
      </>
    )
  }
  return (
    <>
      <Cell id="container-list">
        <ContainerList />
      </Cell>
      <Cell id="container-hp">
        <ContainerDetail
          name="Bosch Compress CS5800iAW (container)"
          hero={<HeatPumpHero />}
          kids={HP_CHILDREN}
          childScenes={[
            { scene: 'heater', status: 'Acqua calda · compressore 18 %' },
            { scene: 'thermostat', status: '30,0 °C · manuale' },
            { scene: 'thermostat', status: '30,0 °C · auto' },
            { scene: 'heater', status: '51,1 °C · Eco+' },
            { scene: 'sensor-sparkline', status: 'collettore 28,0 °C' },
          ]}
        />
      </Cell>
      <Cell id="container-energy">
        <ContainerDetail
          name="Enpal Box + Sungrow SH12T (container)"
          hero={<EnergyHero flows={linked} caption="AUTOCONSUMO · batteria in carica" />}
          kids={EN_CHILDREN}
          childScenes={[
            { scene: 'plug', status: 'FV 1,23 kW · casa 895 W' },
            { scene: 'plug', status: '98,9 % · in carica 339 W' },
            { scene: 'plug', status: 'in funzione · 12 kW' },
            { scene: 'plug', status: '5 W' },
          ]}
        />
      </Cell>
    </>
  )
}

export function Hero476Preview(): ReactElement {
  const view = new URLSearchParams(window.location.search).get('view') ?? 'hp'
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return (
    <ThemeProvider>
      <TrpcClientProvider client={fakeClient() as never}>
        <trpc.Provider client={fakeClient() as never} queryClient={client}>
          <QueryClientProvider client={client}>
            <main className="flex min-h-screen flex-wrap content-start items-start gap-4 bg-background p-4">
              <View view={view} />
            </main>
          </QueryClientProvider>
        </trpc.Provider>
      </TrpcClientProvider>
    </ThemeProvider>
  )
}
