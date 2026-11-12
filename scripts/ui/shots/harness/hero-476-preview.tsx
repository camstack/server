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
import { AdminUiTextProvider } from '@admin/i18n/AdminUiTextProvider'
import {
  Badge,
  Button,
  DeviceRow,
  DeviceValuePicker,
  HeroCardA,
  HeroRowLine,
  HeroScene,
  HeroSegmented,
  type PickedValue,
  PrimaryChildPicker,
  SectionCard,
  Select,
  SettingRow,
  ThemeProvider,
  TrpcClientProvider,
  trpc,
} from '@camstack/ui-library'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BatteryCharging,
  BatteryMedium,
  Droplets,
  Flame,
  House,
  Settings2,
  Sun,
  Gauge,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { type ReactElement, type ReactNode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fakeClient } from './stubs/transport'
import { n, HeatPumpArt, EnergyFlowArt, IDLE_W, wattsText, type EnergyFlows } from './hero-476-art'
import {
  SYSTEM_MODES,
  NOW_FLOWS,
  NIGHT_FLOWS,
  LINKED_FLOWS,
  HP_CHILDREN,
  EN_CHILDREN,
} from './hero-476-fixtures'

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

/** The "Sistema" group: one segmented control per mode, each its own row. */
function SystemModes(): ReactNode {
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(SYSTEM_MODES.map((m) => [m.key, m.initial])),
  )
  return (
    <>
      <div className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Sistema
      </div>
      {SYSTEM_MODES.map((mode) => (
        <HeroRowLine
          key={mode.key}
          testId="system-mode-row"
          label={mode.label}
          actions={
            <HeroSegmented
              label={mode.label}
              tone="warning"
              value={values[mode.key] ?? mode.initial}
              options={mode.options}
              onChange={(v) => setValues({ ...values, [mode.key]: v })}
            />
          }
        />
      ))}
    </>
  )
}

/** Live power of the unit; `null` = not reported (a missing reading is never drawn as 0). */
export interface HeatPumpPower {
  readonly thermalW: number | null
  readonly electricalW: number | null
}

const kw = (w: number): string => `${n(w / 1000, 2)} kW`

/** "COP istantaneo": thermal over electrical power, only when BOTH are known and the unit draws power. */
function instantCop(p: HeatPumpPower): number | null {
  if (p.thermalW === null || p.electricalW === null || p.electricalW <= 0) return null
  return p.thermalW / p.electricalW
}

/** The "Pompa di calore" hero, with the operator's real values (Compress CS5800iAW via HomeCom). */
export function HeatPumpHero({
  title = 'Pompa di calore',
  power = { thermalW: 9200, electricalW: 2991 },
}: {
  readonly title?: string
  readonly power?: HeatPumpPower
}): ReactNode {
  const cop = instantCop(power)
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
          <PillGroup label="Potenza" testId="power-row">
            <>
              <Badge variant="neutral" style="outline" icon={<Flame />}>
                Termica {power.thermalW === null ? '—' : kw(power.thermalW)}
              </Badge>
              <Badge variant="neutral" style="outline" icon={<Zap />}>
                Elettrica {power.electricalW === null ? '—' : kw(power.electricalW)}
              </Badge>
              <Badge
                variant={cop === null ? 'neutral' : 'success'}
                style={cop === null ? 'outline' : 'solid'}
                icon={<Gauge />}
              >
                COP istantaneo {cop === null ? '—' : n(cop)}
              </Badge>
            </>
          </PillGroup>
          <HeroRowLine testId="energy-row" label="Oggi">
            <div className="text-xs">
              Prodotta {n(74.16, 2)} kWh · assorbita {n(30.46, 2)} kWh
            </div>
          </HeroRowLine>
          <SystemModes />
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
/** A labelled group of pills spanning the whole card width (a pill row needs more room than a label + value row). */
function PillGroup({
  label,
  testId,
  children,
}: {
  readonly label: string
  readonly testId: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-surface px-3 py-2"
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

/** One value pill: icon + text, tone by what it is. */
function FlowPill({
  icon: Icon,
  variant,
  children,
}: {
  readonly icon: LucideIcon
  readonly variant: 'neutral' | 'success' | 'info' | 'warning'
  readonly children: ReactNode
}): ReactNode {
  return (
    <Badge
      variant={variant}
      style={variant === 'neutral' ? 'outline' : 'solid'}
      size="md"
      icon={<Icon />}
    >
      {children}
    </Badge>
  )
}

/** The live values of the energy hero as pills: house total, grid import and export apart, battery with direction. */
function EnergyPills({ flows }: { readonly flows: EnergyFlows }): ReactNode {
  const imp = Math.max(flows.grid, 0)
  const exp = Math.max(-flows.grid, 0)
  const bat = flows.battery
  const batteryText =
    Math.abs(bat) < IDLE_W
      ? 'Batteria ferma'
      : bat > 0
        ? `In carica ${wattsText(bat)}`
        : `In scarica ${wattsText(bat)}`
  return (
    <>
      <FlowPill icon={House} variant="neutral">
        Casa {wattsText(flows.house)}
      </FlowPill>
      {flows.heatPump === null ? null : (
        <FlowPill icon={Flame} variant="warning">
          di cui PdC {wattsText(flows.heatPump)} ·{' '}
          {String(Math.round((flows.heatPump / flows.house) * 100))} %
        </FlowPill>
      )}
      <FlowPill icon={Sun} variant={flows.pv >= IDLE_W ? 'warning' : 'neutral'}>
        FV {wattsText(flows.pv)}
      </FlowPill>
      <FlowPill icon={ArrowDownToLine} variant={imp >= IDLE_W ? 'info' : 'neutral'}>
        Da rete {wattsText(imp)}
      </FlowPill>
      <FlowPill icon={ArrowUpFromLine} variant={exp >= IDLE_W ? 'success' : 'neutral'}>
        Verso rete {wattsText(exp)}
      </FlowPill>
      <FlowPill
        icon={bat > 0 ? BatteryCharging : BatteryMedium}
        variant={bat > 0 ? 'success' : bat < 0 ? 'warning' : 'neutral'}
      >
        {batteryText}
      </FlowPill>
    </>
  )
}

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
        <Badge variant="neutral" size="sm">
          Enpal
        </Badge>
      }
      scene={
        <HeroScene scene="plug" state="on" caption={caption} className="h-56">
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
                wrapperClassName="relative w-32 max-w-full"
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
          <PillGroup label="Adesso" testId="energy-pills">
            <EnergyPills flows={flows} />
          </PillGroup>
          <PillGroup label="Oggi" testId="energy-today">
            <>
              <Badge variant="neutral" style="outline">
                FV {n(4.0)} kWh
              </Badge>
              <Badge variant="neutral" style="outline">
                Consumo {n(3.6)} kWh
              </Badge>
              <Badge variant="neutral" style="outline">
                Import {n(0.8)} kWh
              </Badge>
              <Badge variant="neutral" style="outline">
                Export {n(1.1)} kWh
              </Badge>
            </>
          </PillGroup>
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
  const [value, setValue] = useState<PickedValue | null>(linked ? { deviceId: 2301 } : null)
  return (
    <SectionCard
      headingId={`customize-${linked ? 'on' : 'off'}`}
      title="Personalizza"
      icon={Settings2}
    >
      <div className="flex flex-col gap-1 p-3">
        <SettingRow label="Pompa di calore">
          <DeviceValuePicker
            pick="device"
            requires={{ caps: ['heat-pump'] }}
            excludeTypes={['container']}
            value={value}
            onChange={setValue}
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
  readonly kids: readonly {
    id: number
    stableId: string
    type: string
    name: string
  }[]
  readonly childScenes: readonly {
    scene: 'heater' | 'thermostat' | 'plug' | 'sensor-sparkline'
    status: string
  }[]
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
  const linked = LINKED_FLOWS
  if (view === 'hp') {
    return (
      <>
        <Cell id="hp">
          <HeatPumpHero />
        </Cell>
        <Cell id="hp-no-reading">
          <HeatPumpHero title="PdC · senza lettura" power={{ thermalW: 9200, electricalW: null }} />
        </Cell>
      </>
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
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )
  return (
    <ThemeProvider>
      <AdminUiTextProvider>
        <TrpcClientProvider client={fakeClient()}>
          <trpc.Provider client={fakeClient()} queryClient={client}>
            <QueryClientProvider client={client}>
              <main className="flex min-h-screen flex-wrap content-start items-start gap-4 bg-background p-4">
                <View view={view} />
              </main>
            </QueryClientProvider>
          </trpc.Provider>
        </TrpcClientProvider>
      </AdminUiTextProvider>
    </ThemeProvider>
  )
}
