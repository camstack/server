/**
 * The shell's data for a REAL device, read from the caps that already own each
 * fact: `device-status` (reachable), `power-meter`, `battery`, `consumables`,
 * `power-source` (the switch upstream) and `remote`. A block is null until its
 * source answered with something — a card never draws a zone the device does
 * not declare.
 */
import { useMemo } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import {
  useConsumablesReset,
  useDeviceManagerGetDevice,
  usePowerSourceForceRestart,
  usePowerSourceGetStatus,
  usePowerSourcePowerOff,
  usePowerSourcePowerOn,
  useRemoteListCommands,
  useRemoteSendCommand,
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
import { coarseDuration } from './coarse-duration'
import { useCommandNotice } from './use-command-notice'

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
  /** Puts a failed command's reason on the card's reason line. */
  readonly fail: (error: unknown) => void
  /** Clears it: the next command went through. */
  readonly succeed: () => void
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
  digits: number,
  group = false,
): CardPowerDetail[] =>
  typeof value === 'number'
    ? [
        {
          id,
          label,
          value: `${value.toFixed(digits)} ${unit}`,
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
  const labels = useDeviceProviderLabelsWith(client, true)
  const status = useDeviceStateSlice(dev?.state.deviceStatus)
  const meter = useDeviceStateSlice(
    dev?.powerMeter === undefined ? undefined : dev.state.powerMeter,
  )
  const battery = useDeviceStateSlice(dev?.battery === undefined ? undefined : dev.state.battery)
  const consumables = useDeviceStateSlice(
    dev?.consumables === undefined ? undefined : dev.state.consumables,
  )
  const supplyPresence = useCapabilityPresence('power-source')
  const supply = usePowerSourceGetStatus({ deviceId }, { enabled: supplyPresence === 'present' })
  const powerOn = usePowerSourcePowerOn()
  const powerOff = usePowerSourcePowerOff()
  const restart = usePowerSourceForceRestart()
  const remotePresence = useCapabilityPresence('remote')
  const remote = useRemoteListCommands({ deviceId }, { enabled: remotePresence === 'present' })
  const send = useRemoteSendCommand()
  const reset = useConsumablesReset()
  const series = useDeviceSeriesList(deviceId)

  const { notice, fail, succeed } = useCommandNotice()

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
          0,
        ),
        ...reading(
          'current',
          t('uiLibrary.deviceCard.power.current', 'Current'),
          meter.current,
          'A',
          1,
        ),
        ...reading(
          'powerFactor',
          t('uiLibrary.deviceCard.power.factor', 'Power factor'),
          meter.powerFactor,
          '',
          2,
        ),
        ...reading(
          'energy',
          t('uiLibrary.deviceCard.power.energy', 'Total energy'),
          meter.energy,
          'kWh',
          1,
          true,
        ),
      ],
    }
  }, [meter, t])

  const items = useMemo((): readonly CardConsumable[] | null => {
    if (consumables === undefined || consumables.items.length === 0) return null
    return consumables.items.map((item) => ({
      key: item.key,
      label: item.label,
      percent: item.level,
      resetLabel:
        item.resettable && canActuate ? t('uiLibrary.deviceCard.consumables.reset', 'Reset') : null,
    }))
  }, [consumables, canActuate, t])

  const hasHistory =
    series.presence === 'present' &&
    series.list.status === 'ok' &&
    (series.list.data?.length ?? 0) > 0
  const common: CardCommon = {
    name: device.data?.name ?? '',
    integration: labels.get(deviceId) ?? null,
    online,
    offlineLabel:
      offlineSince === null
        ? null
        : t('uiLibrary.deviceCard.offlineFor', 'Offline for {{duration}}', {
            duration: coarseDuration(Date.now() - offlineSince, t),
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
    consumables: items,
    remote:
      remote.data === undefined || remote.data === null || remote.data.commands.length === 0
        ? null
        : remote.data.commands.map((c) => ({
            id: c.role,
            label: c.label ?? c.role,
          })),
    history: hasHistory
      ? { charts: <DeviceHistoryView deviceId={deviceId} />, events: null }
      : null,
  }

  const actions: CardCommonActions = {
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
    onConsumableReset: (key: string) =>
      reset.mutate({ deviceId, key }, { onSuccess: succeed, onError: fail }),
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
    fail,
    succeed,
  }
}
