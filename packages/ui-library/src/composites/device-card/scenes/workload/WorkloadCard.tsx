import type { WorkloadAction, WorkloadControl } from '@camstack/types'
import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import type { CardGlyph } from '../../icons'
import { CardIcon } from '../../parts/CardIcon'
import { type BottomRow, rowPills, rowStats, rowText } from '../../shell/bottom-rows'
import { type ColumnItem, columnArmedButton, columnButton } from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { ScenePower } from '../../shell/ScenePower'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import {
  WORKLOAD_ROLE_GLYPH,
  WORKLOAD_STATE_TONE,
  type WorkloadCardActions,
  type WorkloadCardModel,
  chunkStats,
  workloadActionLabel,
  workloadColumnControls,
  workloadIsOn,
  workloadPortText,
  workloadResourceStats,
  workloadScenePower,
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

/** Restart and force stop interrupt what runs: two steps. Force stop is the danger one. */
function controlItem(
  control: WorkloadControl,
  actions: WorkloadCardActions,
  label: string,
): ColumnItem {
  const testId = `dc-workload-${control.action}`
  const disabled = !control.enabled
  if (control.action === 'restart' || control.action === 'forceStop') {
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

/**
 * A VM, an app container, an LXC, an app or a host: its state, the controls
 * its provider declared (start and stop as the power toggle on the scene),
 * the resources it reported and where it runs. Nothing the provider did not
 * declare or report is drawn.
 */
export function WorkloadCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: WorkloadCardProps): ReactElement {
  const t = useUiText()
  const power = workloadScenePower(model.controls, model.state)
  const glyph = WORKLOAD_ROLE_GLYPH[model.role]
  const on = workloadIsOn(model.state)
  const drawing = (
    <CardIcon
      glyph={glyph}
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
  const image =
    power === null || !power.enabled ? (
      drawing
    ) : (
      <ScenePower
        on={power.on}
        label={workloadActionLabel(power.on ? 'stop' : 'start', model.role, t)}
        testId="dc-workload-power"
        onToggle={(next) => actions.onAction(next ? 'start' : 'stop')}
      >
        {drawing}
      </ScenePower>
    )
  const right = workloadColumnControls(model.controls, power !== null, model.state).map((c) =>
    controlItem(c, actions, workloadActionLabel(c.action, model.role, t)),
  )
  const host = model.host
  const openDevice = actions.onOpenDevice
  const left =
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
  const resources = model.sections.resources ? workloadResourceStats(model.resources, t) : []
  return (
    <DeviceCard
      kind="workload"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.state ?? 'unknown'}
      state={{
        label: workloadStateLabel(model.state, model.role, t),
        since: model.since,
        tone: model.state === null ? 'muted' : WORKLOAD_STATE_TONE[model.state],
      }}
      scene={{
        alert: model.state === 'crashed',
        columns: { left, right },
        image,
        bottom: [
          // Three per row: "Memory of 8.0 GB" stays on one line on a phone.
          ...chunkStats(resources, 3).map((stats, i) =>
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
