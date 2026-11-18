import type { WorkloadAction, WorkloadControl } from '@camstack/types'
import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import type { CardGlyph } from '../../icons'
import { ArcGauge } from '../../parts/ArcGauge'
import { CardIcon } from '../../parts/CardIcon'
import { StateDot } from '../../parts/StateDot'
import { type BottomRow, rowPills, rowStats, rowText } from '../../shell/bottom-rows'
import { type ColumnItem, columnArmedButton, columnButton } from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import {
  WORKLOAD_ROLE_GLYPH,
  WORKLOAD_STATE_TONE,
  type WorkloadCardActions,
  type WorkloadCardModel,
  type WorkloadGauge,
  balancedStatRows,
  workloadActionLabel,
  workloadControlColumns,
  workloadExtraStats,
  workloadGauges,
  workloadIsOn,
  workloadPortText,
  workloadStateLabel,
} from './model'

export interface WorkloadCardProps {
  readonly model: WorkloadCardModel
  readonly actions: WorkloadCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const ACTION_GLYPH: Readonly<Record<WorkloadAction, CardGlyph>> = {
  start: 'power',
  stop: 'stop',
  restart: 'restart',
  pause: 'pause',
  resume: 'play',
  forceStop: 'forceStop',
}

/** Stop, restart and force stop interrupt what runs: two steps. Force stop is the danger one. */
const ARMED: ReadonlySet<WorkloadAction> = new Set(['stop', 'restart', 'forceStop'])

/** While a command is in flight (`busy`) every action waits: none is sent twice. */
function controlItem(
  control: WorkloadControl,
  actions: WorkloadCardActions,
  label: string,
  busy: boolean,
): ColumnItem {
  const testId = `dc-workload-${control.action}`
  const disabled = !control.enabled || busy
  if (ARMED.has(control.action)) {
    return columnArmedButton(control.action, {
      glyph: ACTION_GLYPH[control.action],
      label,
      tone: control.action === 'forceStop' ? 'danger' : undefined,
      disabled,
      testId,
      onConfirm: () => actions.onAction(control.action),
    })
  }
  return columnButton(control.action, {
    glyph: ACTION_GLYPH[control.action],
    label,
    disabled,
    testId,
    onPress: () => actions.onAction(control.action),
  })
}

/** Ports, addresses, autostart and the update notice: each only when declared and present. */
function factRows(model: WorkloadCardModel, t: ReturnType<typeof useUiText>): BottomRow[] {
  const facts = [
    { id: 'os', name: t('uiLibrary.deviceCard.workload.os', 'System'), value: model.os },
    {
      id: 'version',
      name: t('uiLibrary.deviceCard.workload.version', 'Version'),
      value: model.version,
    },
  ].flatMap((f) =>
    f.value === null
      ? []
      : [{ id: f.id, name: f.name, value: f.value, testId: `dc-workload-${f.id}` }],
  )
  const autostart =
    model.sections.autostart && model.autostart !== null
      ? [
          rowText('autostart', {
            text: model.autostart
              ? t('uiLibrary.deviceCard.workload.autostartOn', 'Starts with its host')
              : t('uiLibrary.deviceCard.workload.autostartOff', 'Does not start with its host'),
            tone: 'muted',
            testId: 'dc-workload-autostart',
          }),
        ]
      : []
  return [
    ...(facts.length === 0 ? [] : [rowStats('facts', { stats: facts })]),
    ...(model.image === null
      ? []
      : [
          rowText('image', {
            label: t('uiLibrary.deviceCard.workload.image', 'Image'),
            text: model.image,
            testId: 'dc-workload-image',
          }),
        ]),
    ...(model.sections.ports && model.ports.length > 0
      ? [
          rowPills('ports', {
            label: t('uiLibrary.deviceCard.workload.ports', 'Ports'),
            testId: 'dc-workload-ports',
            pills: model.ports.map((port) => ({
              id: `${port.port}/${port.protocol}/${port.hostPort ?? ''}`,
              text: workloadPortText(port),
            })),
          }),
        ]
      : []),
    ...(model.sections.addresses && model.addresses.length > 0
      ? [
          rowPills('addresses', {
            label: t('uiLibrary.deviceCard.workload.addresses', 'Addresses'),
            testId: 'dc-workload-addresses',
            pills: model.addresses.map((address) => ({ id: address, text: address })),
          }),
        ]
      : []),
    ...autostart,
    ...(model.sections.update && model.updateAvailable === true
      ? [
          rowText('update', {
            glyph: 'install',
            tone: 'warning',
            text: t('uiLibrary.deviceCard.workload.updateAvailable', 'An update is available'),
            testId: 'dc-workload-update',
          }),
        ]
      : []),
  ]
}

interface GaugeCellProps {
  readonly gauge: WorkloadGauge
  readonly on: boolean
}

function GaugeCell({ gauge, on }: GaugeCellProps): ReactElement {
  return (
    <div
      className="grid w-full justify-items-center gap-0.5"
      data-testid={`dc-workload-gauge-${gauge.id}`}
    >
      <ArcGauge
        percent={gauge.percent}
        text={gauge.text}
        label={gauge.label}
        tone={on ? 'primary' : 'muted'}
      />
      {gauge.detail === null ? null : (
        <small className="text-xs tabular-nums text-foreground-muted">{gauge.detail}</small>
      )}
    </div>
  )
}

/**
 * A VM, an app container, an LXC, an app or a host. The hero: a state dot with
 * how long it has been in that state, CPU and RAM as gauges ("—" when not
 * reported), and only the actions its provider declared — start or stop and
 * restart on the right, pause or resume and force stop on the left. Every
 * action shows the served state; nothing is assumed before the hub says so.
 */
export function WorkloadCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: WorkloadCardProps): ReactElement {
  const t = useUiText()
  const on = workloadIsOn(model.state)
  const stateLabel = workloadStateLabel(model.state, model.role, t)
  const columns = workloadControlColumns(model.controls, model.state)
  const item = (c: WorkloadControl): ColumnItem =>
    controlItem(c, actions, workloadActionLabel(c.action, model.role, t), model.busy)
  const status = (
    <div
      data-testid="dc-workload-status"
      className="flex items-center gap-1.5 text-sm text-foreground"
      title={stateLabel}
    >
      <StateDot
        testId="dc-workload-dot"
        state={model.state ?? 'unknown'}
        tone={model.state === null ? null : WORKLOAD_STATE_TONE[model.state]}
      />
      {/* The state word is the corner's; the hero adds only how long. */}
      {model.uptime === null ? null : (
        <span className="font-semibold tabular-nums">{model.uptime}</span>
      )}
    </div>
  )
  const drawing = model.sections.resources ? (
    <div className="grid w-full grid-cols-2 justify-items-center gap-2">
      {workloadGauges(model.resources, t).map((g) => (
        <GaugeCell key={g.id} gauge={g} on={on === true} />
      ))}
    </div>
  ) : (
    <CardIcon
      glyph={WORKLOAD_ROLE_GLYPH[model.role]}
      className={cn(
        SCENE_ICON_CLASS,
        model.state === 'crashed'
          ? 'text-danger'
          : on === true
            ? 'text-primary'
            : 'text-foreground-muted',
      )}
    />
  )
  const host = model.host
  const openDevice = actions.onOpenDevice
  const hostItem =
    host === null || openDevice === undefined
      ? []
      : [
          columnButton('host', {
            glyph: 'host',
            onPress: () => openDevice(host.deviceId),
            label:
              host.name === null
                ? t('uiLibrary.deviceCard.workload.openHost', 'Open the host')
                : t('uiLibrary.deviceCard.workload.openHostNamed', 'Open {{name}}', {
                    name: host.name,
                  }),
            testId: 'dc-workload-host',
          }),
        ]
  const extra = model.sections.resources ? workloadExtraStats(model.resources, t) : []
  return (
    <DeviceCard
      kind="workload"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.state ?? 'unknown'}
      state={{
        label: stateLabel,
        // The duration sits in the hero, next to the state dot.
        since: null,
        tone: model.state === null ? 'muted' : WORKLOAD_STATE_TONE[model.state],
      }}
      scene={{
        alert: model.state === 'crashed',
        columns: {
          left: [...hostItem, ...columns.more.map(item)],
          right: columns.lifecycle.map(item),
        },
        image: (
          <div className="grid w-full justify-items-center gap-2">
            {status}
            {drawing}
          </div>
        ),
        bottom: [
          // At most three per row, so a stat name stays on one line on a phone.
          ...balancedStatRows(extra, 3).map((stats, i) =>
            rowStats(`resources-${i}`, {
              label:
                i === 0 ? t('uiLibrary.deviceCard.workload.resources', 'Resources') : undefined,
              stats,
              testId: `dc-workload-resources-${i}`,
            }),
          ),
          ...factRows(model, t),
        ],
      }}
    />
  )
}
