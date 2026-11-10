import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import {
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
} from '../../generated/system-hooks'
import { Button } from '../../primitives/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { DeviceValueField, type DeviceValuePick } from '../device-value-field/device-value-field'
import {
  type DeviceValueCandidate,
  useDeviceValueSource,
} from '../device-value-field/use-device-value-source'
import {
  type DeviceCapFields,
  type DeviceTemplateAccepts,
  deviceTemplateToken,
  fieldAccepts,
} from './device-template-model'

export interface DeviceTemplateInsertProps {
  readonly accepts: DeviceTemplateAccepts
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** The finished `{{ alias.field }}` token. */
  readonly onInsert: (token: string) => void
  /** The device the text is written for: picking it writes the copyable `camera` alias. */
  readonly thisDeviceId?: number
  readonly capTitle?: (cap: string) => string
  readonly fieldLabel?: (cap: string, path: string) => string
}

const IDENTITY_CAP = (cap: string): string => cap
const IDENTITY_FIELD = (_cap: string, path: string): string => path

/**
 * The "insert value" dialog: device → capability → field, offering only the fields the
 * slot accepts, and writing the alias form of the token (the cap spelled out when the
 * field name is ambiguous on that device).
 */
export function DeviceTemplateInsert(props: DeviceTemplateInsertProps): ReactNode {
  const t = useUiText()
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [pick, setPick] = useState<DeviceValuePick | null>(null)
  const { accepts, onOpenChange } = props
  const fit = useCallback(
    (field: DeviceValueCandidate): string | null => (fieldAccepts(accepts, field.kind) ? '' : null),
    [accepts],
  )
  const source = useDeviceValueSource({
    deviceId,
    fit,
    capTitle: props.capTitle ?? IDENTITY_CAP,
    fieldLabel: props.fieldLabel ?? IDENTITY_FIELD,
  })
  const all = useDeviceManagerListAll({ projection: 'slim' })
  const wireable = useDeviceManagerGetWireableFields(
    { deviceId: deviceId ?? 0 },
    { enabled: deviceId !== null },
  )
  const device = all.data?.find((d) => d.id === deviceId)
  const caps = useMemo(
    (): readonly DeviceCapFields[] =>
      (wireable.data?.caps ?? []).map((c) => ({
        cap: c.cap,
        paths: c.fields.filter((f) => f.item !== true).map((f) => f.path),
      })),
    [wireable.data],
  )
  const close = (): void => {
    onOpenChange(false)
    setDeviceId(null)
    setPick(null)
  }
  const alias = deviceId !== null && deviceId === props.thisDeviceId ? 'camera' : device?.alias
  const confirm = (): void => {
    if (pick === null || alias === undefined) return
    props.onInsert(deviceTemplateToken(alias, pick, caps))
    close()
  }
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('uiLibrary.deviceTemplateField.insertTitle', 'Insert a device value')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DeviceValueField
            {...source}
            deviceId={deviceId}
            onDeviceChange={(id) => {
              setDeviceId(id)
              setPick(null)
            }}
            deviceLabel={device?.name ?? ''}
            value={pick}
            onValueChange={setPick}
            heading={t('uiLibrary.deviceValueField.pickDevice', 'Pick a device')}
            noDeviceText={t(
              'uiLibrary.deviceValueField.noDevice',
              'Pick a device to see its values.',
            )}
            noValuesText={t(
              'uiLibrary.deviceTemplateField.noFittingValue',
              'This device has no value that fits here.',
            )}
          />
          {deviceId !== null && all.status === 'success' && alias === undefined && (
            <p className="mt-2 text-xs text-warning" role="alert">
              {t(
                'uiLibrary.deviceTemplateField.noAlias',
                'This device has no name for templates yet; set one on its page first.',
              )}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {t('uiLibrary.deviceValueField.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={pick === null || alias === undefined}
            data-testid="device-template-insert-confirm"
            onClick={confirm}
          >
            {t('uiLibrary.deviceTemplateField.insert', 'Insert')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
