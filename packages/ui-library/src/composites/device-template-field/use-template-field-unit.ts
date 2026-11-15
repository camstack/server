import { runtimeFieldUnit, templateCapKey } from '@camstack/types'
import {
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
} from '../../generated/system-hooks'
import type { TemplateFieldSource } from './device-template-model'

/**
 * The unit of the device field a pipe chain starts from (`garage.temperature`), as the
 * editor already knows it for "+ Device value". Undefined while it loads, for a field with
 * no declared unit, and when there is no field at all: callers then offer every unit.
 */
export function useTemplateFieldUnit(
  source: TemplateFieldSource | null,
  thisDeviceId: number | undefined,
): string | undefined {
  const all = useDeviceManagerListAll({ projection: 'slim' })
  const deviceId =
    source === null
      ? null
      : source.alias === 'camera'
        ? (thisDeviceId ?? null)
        : (all.data?.find((d) => d.alias === source.alias)?.id ?? null)
  const wireable = useDeviceManagerGetWireableFields(
    { deviceId: deviceId ?? 0 },
    { enabled: deviceId !== null },
  )
  if (source === null) return undefined
  for (const cap of wireable.data?.caps ?? []) {
    if (cap.fields.some((f) => f.path === source.path))
      return runtimeFieldUnit(cap.cap, source.path)
    // `alias.cap_name.field`: the cap spelled out because the field name is ambiguous.
    const prefix = `${templateCapKey(cap.cap)}.`
    if (source.path.startsWith(prefix))
      return runtimeFieldUnit(cap.cap, source.path.slice(prefix.length))
  }
  return undefined
}
