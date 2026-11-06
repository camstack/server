import { type ReactNode, useCallback, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { Button } from '../../primitives/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { DeviceValueField, type DeviceValuePick } from './device-value-field'
import { type DeviceValueRef, formatDeviceValueToken } from './device-value-token'
import { type DeviceValueCandidate, useDeviceValueSource } from './use-device-value-source'

export interface DeviceValueTokenFieldProps {
  /** Resolves the picked device's `stableId` once the operator confirms. */
  readonly stableIdOf: (deviceId: number) => string | null
  readonly capNames?: readonly string[]
  readonly fit?: (field: DeviceValueCandidate) => string | null
  readonly capTitle?: (cap: string) => string
  readonly fieldLabel?: (cap: string, path: string) => string
  /** Receives the token text (`{{dev:<stableId>/<cap>.<fieldPath>}}`) and what it points at. */
  readonly onPick: (token: string, ref: DeviceValueRef) => void
  readonly trigger: ReactNode
}

const AS_IS = (): string => ''
const IDENTITY_CAP = (cap: string): string => cap
const IDENTITY_FIELD = (_cap: string, path: string): string => path

/**
 * The template-token adapter of the device → value picker: pick a device, then one
 * of its fitting values, and get the token a template writes. Picking only; a
 * template engine renders the token elsewhere.
 */
export function DeviceValueTokenField(props: DeviceValueTokenFieldProps): ReactNode {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [pick, setPick] = useState<DeviceValuePick | null>(null)
  const source = useDeviceValueSource({
    deviceId,
    capNames: props.capNames,
    fit: props.fit ?? AS_IS,
    capTitle: props.capTitle ?? IDENTITY_CAP,
    fieldLabel: props.fieldLabel ?? IDENTITY_FIELD,
  })
  const close = useCallback((): void => {
    setOpen(false)
    setDeviceId(null)
    setPick(null)
  }, [])
  const confirm = (): void => {
    if (deviceId === null || pick === null) return
    const stableId = props.stableIdOf(deviceId)
    if (stableId === null) return
    const ref = { stableId, cap: pick.cap, fieldPath: pick.path }
    props.onPick(formatDeviceValueToken(ref), ref)
    close()
  }
  return (
    <>
      <span
        role="presentation"
        data-testid="device-value-token-open"
        onClick={() => setOpen(true)}
        onKeyDown={() => undefined}
      >
        {props.trigger}
      </span>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent width="xl" placement="sheet-on-mobile" scroll="body">
          <DialogHeader>
            <DialogTitle>
              {t('uiLibrary.deviceValueField.tokenTitle', 'Insert a device value')}
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
              deviceLabel={source.devices.find((d) => d.id === deviceId)?.name ?? ''}
              value={pick}
              onValueChange={setPick}
              heading={t('uiLibrary.deviceValueField.pickDevice', 'Pick a device')}
              backLabel={t('uiLibrary.deviceValueField.back', 'Back')}
              noDeviceText={t(
                'uiLibrary.deviceValueField.noDevice',
                'Pick a device to see its values.',
              )}
              noValuesText={t(
                'uiLibrary.deviceValueField.noValues',
                'This device has no value that fits.',
              )}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={close}>
              {t('uiLibrary.deviceValueField.cancel', 'Cancel')}
            </Button>
            <Button disabled={pick === null} onClick={confirm}>
              {t('uiLibrary.deviceValueField.use', 'Use this value')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
