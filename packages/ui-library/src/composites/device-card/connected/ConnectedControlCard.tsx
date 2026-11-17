import type { ControlSetValueInput } from '@camstack/types'
import type { ReactElement } from 'react'
import { useOptionalSystem, useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useUnitPreferences } from '../../../contexts/unit-preferences'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceCommand } from '../../../hooks/use-device-command'
import { formatControlDateTime } from '../../../lib/format-control-datetime'
import { controlQuantityOf, numericControlDisplay } from '../../device-controls/control-panel'
import { ControlCard } from '../scenes/control/ControlCard'
import type { ControlCardValue } from '../scenes/control/model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { controlCardValueOf, controlSetInput } from './control-model'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * A settable value (`control`). A number is shown and typed in the operator's
 * unit and sent in the device's (the reading's own resolution); a date keeps
 * the shape its source declares. The cap carries no text length limit, so the
 * card draws none.
 */
export function ConnectedControlCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const info = useOptionalSystem()?.getDeviceInfo(deviceId) ?? null
  const unitPreferences = useUnitPreferences()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(dev?.control === undefined ? undefined : dev.state.control)
  const display = slice
  const runCommand = useDeviceCommand()
  const cap = dev?.control
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(runCommand, card)
  const numeric = numericControlDisplay({
    quantity: controlQuantityOf(info?.sourceInfo?.quantity),
    display: info?.display,
    unitPreferences,
  })
  const shape = info?.sourceInfo?.dateTimeShape ?? 'datetime'
  const control: ControlCardValue = controlCardValueOf(display, numeric, shape, (raw) =>
    formatControlDateTime(raw, shape),
  )
  return (
    <ControlCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        control,
        since: sinceText(display.lastChangedAt, Date.now(), t) ?? null,
        settable: card.implements('control', 'setValue'),
      }}
      actions={{
        ...card.actions,
        onSet: (value) => {
          const input: ControlSetValueInput | null = controlSetInput(display.kind, value, numeric)
          if (input !== null) send(() => cap.setValue({ control: input }))
        },
      }}
    />
  )
}
