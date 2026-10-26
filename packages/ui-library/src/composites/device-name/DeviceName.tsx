/**
 * The one place a device's name is painted. Pass `form` for the surface:
 * `compact` in a list or picker, `full` on a page title, `nested` under the
 * parent row, `with-location` when the room belongs on the line.
 */
import type { ReactElement } from 'react'
import type { DeviceNameFields, DeviceNameForm } from './format-device-name'
import { useDeviceLabel } from './use-device-label'

export interface DeviceNameProps {
  readonly device: DeviceNameFields
  readonly form: DeviceNameForm
  /** Skip the fleet when the caller already holds the parent row. */
  readonly parent?: DeviceNameFields | null
  readonly siblings?: readonly DeviceNameFields[]
  readonly className?: string
  readonly testId?: string
}

export function DeviceName({
  device,
  form,
  parent,
  siblings,
  className,
  testId,
}: DeviceNameProps): ReactElement {
  const label = useDeviceLabel(device, form, {
    ...(parent !== undefined ? { parent } : {}),
    ...(siblings !== undefined ? { siblings } : {}),
  })
  return (
    <span className={className} title={label} data-testid={testId}>
      {label}
    </span>
  )
}
