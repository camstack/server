import { useState, type ReactElement } from 'react'
import type { IrLearnResult } from '@camstack/types'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useIrTransmitterGetInfo, useIrTransmitterLearn } from '../../../generated/system-hooks'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { IrTransmitterCard } from '../scenes/ir/IrTransmitterCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import {
  type IrLearnProbe,
  IR_PROBE_IDLE,
  irClientErrorCode,
  irTransmitterScene,
} from './ir-transmitter-model'
import { useCardCommon } from './use-card-common'

/**
 * An IR or RF transmitter. Info says which media it speaks and whether it can
 * learn; the runtime slice says how the last send and the last learn ended.
 * The learn button shows the code it read and saves nothing.
 */
export function ConnectedIrTransmitterCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const infoQuery = useIrTransmitterGetInfo({ deviceId })
  const slice = useDeviceStateSlice(dev?.state.irTransmitter)
  const learn = useIrTransmitterLearn()
  const [probe, setProbe] = useState<IrLearnProbe>(IR_PROBE_IDLE)
  const infoData = infoQuery.status === 'success' ? infoQuery.data : undefined
  const scene = irTransmitterScene({
    info: infoData === undefined ? null : { media: infoData.media, learn: infoData.learn },
    slice: slice === undefined ? null : { lastSend: slice.lastSend, lastLearn: slice.lastLearn },
    probe: { ...probe, pending: probe.pending || learn.isPending },
    readOnly: card.common.readOnly,
    now: Date.now(),
    t,
  })
  const onLearn = (): void => {
    setProbe({ pending: true, result: null, errorCode: null })
    learn.mutate(
      { deviceId },
      {
        onSuccess: (result: IrLearnResult) => {
          card.succeed()
          setProbe({ pending: false, result, errorCode: null })
        },
        onError: (error: unknown) => {
          card.fail(error)
          setProbe({ pending: false, result: null, errorCode: irClientErrorCode(error) })
        },
      },
    )
  }
  return (
    <IrTransmitterCard
      orientation={orientation}
      showName={showName}
      model={{ common: card.common, ...scene }}
      actions={{ ...card.actions, onLearn }}
    />
  )
}
