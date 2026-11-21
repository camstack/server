/**
 * The shell's data for a REAL device, read from the caps that already own each
 * fact: `device-status` (reachable), `power-meter`, `battery`, `consumables`,
 * `power-source` (the switch upstream) and `remote`. A block is null until its
 * source answered with something — a card never draws a zone the device does
 * not declare.
 */
import { useMemo } from 'react'
import { useOptionalSystem, useTrpcClient } from '../../../contexts/system-context'
import { formatNumeric } from '../../../lib/format-numeric'
import { useUiText } from '../../../contexts/ui-text'
import {
  useConsumablesReset,
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
  usePowerSourceForceRestart,
  usePowerSourceGetStatus,
  usePowerSourcePowerOff,
  usePowerSourcePowerOn,
  useRemoteGetAssumedStatus,
  useRemoteListCommands,
  useRemoteSendCommand,
  useTemplateList,
} from '../../../generated/system-hooks'
import { useCapabilityPresence } from '../../../hooks/use-capability-presence'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceProviderLabelsWith } from '../../device-picker/device-provider-label'
import { DeviceHistoryView } from '../../device-history/DeviceHistoryView'
import { useDeviceSeriesList } from '../../device-history/use-device-history'
import type {
  CardCommon,
  CardCommonActions,
  CardConsumable,
  CardPower,
  CardPowerDetail,
  CardSupplyAction,
} from '../shell/model'
import { cardFaultsOf } from '../shell/model'
import { toCardConsumable } from './consumable-card-item'
import { remoteLayoutPending, remotePanelOf } from './remote-panel'
import { remoteKeyOf } from '../shell/remote-keys'
import { sinceText } from './since-text'
import { useCommandNotice } from './use-command-notice'
import { useMotionTrigger } from './use-motion-trigger'

export interface CardCommonInput {
  readonly deviceId: number
  /** False when the viewer may look but not command. */
  readonly canActuate: boolean
}

export interface CardCommonResult {
  readonly common: CardCommon
  readonly actions: CardCommonActions
  /** The device's type, once the registry answered. */
  readonly deviceType: string | null
  readonly role: string | null
  /** What the device declares it can do (`DeviceFeature` values); empty until it answered. */
  readonly features: readonly string[]
  /**
   * Whether the device's binding of `cap` implements `method`. False until the
   * bindings answered: a control is drawn only once the device has said it has it.
   */
  readonly implements: (cap: string, method: string) => boolean
  /** Puts a failed command's reason on the card's reason line. */
  readonly fail: (error: unknown) => void
  /** Clears it: the next command went through. */
  readonly succeed: () => void
}

/** The binding answered for `cap`, and its provider has `method` (an absent list means every method). */
export function bindingImplements(
  entries: readonly BindingMethods[] | undefined,
  cap: string,
  method: string,
): boolean {
  const entry = entries?.find((e) => e.capName === cap)
  if (entry === undefined) return false
  return entry.implementedMethods === undefined || entry.implementedMethods.includes(method)
}

/** What a binding entry says about its methods. */
export interface BindingMethods {
  readonly capName: string
  readonly implementedMethods?: readonly string[] | undefined
}

/**
 * Reachability as the device reports it. A device whose `device-status` has
 * not answered is unknown: neither drawn as online nor blocked as offline.
 */
export function reachabilityOf(status: { readonly online: boolean } | undefined): boolean | null {
  return status === undefined ? null : status.online
}

const reading = (
  id: string,
  label: string,
  value: number | null | undefined,
  unit: string,
  precision: number | undefined,
  group = false,
): CardPowerDetail[] =>
  typeof value === 'number'
    ? [
        {
          id,
          label,
          value:
            unit === ''
              ? formatNumeric(value, precision)
              : `${formatNumeric(value, precision)} ${unit}`,
          ...(group ? { group } : {}),
        },
      ]
    : []

const NO_FEATURES: readonly string[] = []

export function useCardCommon({ deviceId, canActuate }: CardCommonInput): CardCommonResult {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const device = useDeviceManagerGetDevice({ deviceId })
  const bindings = useDeviceManagerGetBindings({ deviceId })
  const labels = useDeviceProviderLabelsWith(client, true)
  // The Precision set in Customize on this device; none = the default number rule.
  const precision = useOptionalSystem()?.getDeviceInfo(deviceId)?.display?.precision
  const status = useDeviceStateSlice(dev?.state.deviceStatus)
  const meter = useDeviceStateSlice(
    dev?.powerMeter === undefined ? undefined : dev.state.powerMeter,
  )
  const battery = useDeviceStateSlice(dev?.battery === undefined ? undefined : dev.state.battery)
  const fault = useDeviceStateSlice(dev?.error === undefined ? undefined : dev.state.error)
  const consumables = useDeviceStateSlice(
    dev?.consumables === undefined ? undefined : dev.state.consumables,
  )
  const supplyPresence = useCapabilityPresence('power-source')
  const supply = usePowerSourceGetStatus({ deviceId }, { enabled: supplyPresence === 'present' })
  const powerOn = usePowerSourcePowerOn()
  const powerOff = usePowerSourcePowerOff()
  const restart = usePowerSourceForceRestart()
  const remotePresence = useCapabilityPresence('remote')
  const transitionsPresence = useCapabilityPresence('device-transitions')
  const remote = useRemoteListCommands({ deviceId }, { enabled: remotePresence === 'present' })
  const templateId = remote.data?.layoutTemplateId ?? null
  const templates = useTemplateList(
    { kind: 'remote' },
    { enabled: remotePresence === 'present' && templateId !== null },
  )
  const assumed = useRemoteGetAssumedStatus({ deviceId }, { enabled: remotePresence === 'present' })
  const send = useRemoteSendCommand()
  const reset = useConsumablesReset()
  const series = useDeviceSeriesList(deviceId)

  const { notice, fail, succeed } = useCommandNotice()
  const motion = useMotionTrigger({
    deviceId,
    settable: bindingImplements(bindings.data?.entries, 'motion-trigger', 'setMotionTrigger'),
    fail,
    succeed,
  })

  const online = reachabilityOf(status)
  const offlineSince = online === false ? (status?.lastChangedAt ?? null) : null

  const power = useMemo((): CardPower | null => {
    if (meter === undefined) return null
    return {
      watts: typeof meter.power === 'number' ? meter.power : null,
      details: [
        ...reading(
          'voltage',
          t('uiLibrary.deviceCard.power.voltage', 'Voltage'),
          meter.voltage,
          'V',
          precision,
        ),
        ...reading(
          'current',
          t('uiLibrary.deviceCard.power.current', 'Current'),
          meter.current,
          'A',
          precision,
        ),
        ...reading(
          'powerFactor',
          t('uiLibrary.deviceCard.power.factor', 'Power factor'),
          meter.powerFactor,
          '',
          precision,
        ),
        ...reading(
          'energy',
          t('uiLibrary.deviceCard.power.energy', 'Total energy'),
          meter.energy,
          'kWh',
          precision,
          true,
        ),
      ],
    }
  }, [meter, t, precision])

  const consumablesBound = dev?.consumables !== undefined
  const items = useMemo((): readonly CardConsumable[] | null => {
    if (!consumablesBound || consumables === undefined) return null
    return consumables.items.map((item) => toCardConsumable(item, canActuate, t, precision))
  }, [consumablesBound, consumables, canActuate, t, precision])

  const seriesReady =
    series.presence === 'present' &&
    series.list.status === 'ok' &&
    (series.list.data?.length ?? 0) > 0
  const actuationsOffered = transitionsPresence !== 'absent'
  const offlineDuration = sinceText(offlineSince, Date.now(), t)
  const common: CardCommon = {
    ...(precision === undefined ? {} : { precision }),
    name: device.data?.name ?? '',
    integration: labels.get(deviceId) ?? null,
    online,
    offlineLabel:
      offlineDuration === undefined
        ? null
        : t('uiLibrary.deviceCard.offlineFor', 'Offline for {{duration}}', {
            duration: offlineDuration,
          }),
    readOnly: !canActuate,
    notice,
    power,
    battery: typeof battery?.level === 'number' ? { level: battery.level } : null,
    supply:
      supply.data?.linked === true
        ? {
            name:
              supply.data.switchName ?? t('uiLibrary.deviceCard.supply.title', 'Upstream supply'),
            state: supply.data.restartInProgress
              ? 'restarting'
              : supply.data.switchOn === false
                ? 'off'
                : 'on',
          }
        : null,
    faults: cardFaultsOf(fault),
    consumables: items,
    consumablesLoading: consumablesBound && consumables === undefined,
    remote:
      remote.data === undefined || remote.data === null || remote.data.commands.length === 0
        ? null
        : remote.data.commands.map((c) => remoteKeyOf(c.role, c.label, t)),
    remotePanel: remotePanelOf(
      deviceId,
      remote.data,
      templates.data,
      templates.status,
      assumed.data,
    ),
    remoteLayoutPending: remoteLayoutPending(remote.data, templates.data, templates.status),
    deviceId,
    motionTrigger: motion.on === null ? null : { on: motion.on, pending: motion.pending },
    history:
      seriesReady || actuationsOffered
        ? {
            charts: seriesReady ? <DeviceHistoryView deviceId={deviceId} /> : null,
            events: null,
          }
        : null,
  }

  const actions: CardCommonActions = {
    onMotionTrigger: motion.onToggle,
    onSupply: (action: CardSupplyAction) => {
      const call = action === 'on' ? powerOn : action === 'off' ? powerOff : restart
      call.mutate(
        { deviceId },
        {
          onSuccess: succeed,
          onError: fail,
          onSettled: () => void supply.refetch(),
        },
      )
    },
    onConsumableReset: (key: string) => reset.mutateAsync({ deviceId, key }).then(succeed, fail),
    onRemoteKey: (id: string) => {
      const command = remote.data?.commands.find((c) => c.role === id)
      if (command !== undefined)
        send.mutate(
          { deviceId, role: command.role, repeat: 1 },
          { onSuccess: succeed, onError: fail },
        )
    },
  }

  return {
    common,
    actions,
    deviceType: device.data?.type ?? null,
    role: device.data?.role ?? null,
    features: device.data?.features ?? NO_FEATURES,
    implements: (cap, method) => bindingImplements(bindings.data?.entries, cap, method),
    fail,
    succeed,
  }
}
