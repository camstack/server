/**
 * The core-blocks side of the ONE door to the device template renderer
 * (D1021): `device-manager.renderDeviceTemplates` over `ctx.api`. An action, a
 * scheduler point and a fan preset all render through this; none owns a copy of
 * the renderer or of the state it reads.
 */
import type {
  AddonApi,
  DeviceTemplateRender,
  DeviceTemplateRefusal,
  RenderStepTemplates,
} from '@camstack/types'

export type TemplateCheckResult =
  | {
      readonly ok: true
      readonly aliases: readonly {
        readonly alias: string
        readonly deviceId: number | null
        readonly allowed: boolean
      }[]
    }
  | { readonly ok: false; readonly refusal: DeviceTemplateRefusal }

export interface DeviceTemplateDoor {
  render(
    templates: readonly string[],
    allowedDeviceIds?: readonly number[],
  ): Promise<readonly DeviceTemplateRender[]>
  check(
    templates: readonly string[],
    allowedDeviceIds?: readonly number[],
  ): Promise<readonly TemplateCheckResult[]>
}

export function templateDoorOver(api: () => AddonApi | undefined): DeviceTemplateDoor {
  const need = (): AddonApi => {
    const current = api()
    if (current === undefined) throw new Error('no ctx.api on this node — templates cannot be rendered')
    return current
  }
  return {
    render: async (templates, allowedDeviceIds) => {
      const out = await need().deviceManager.renderDeviceTemplates.query({
        templates: [...templates],
        ...(allowedDeviceIds === undefined ? {} : { allowedDeviceIds: [...allowedDeviceIds] }),
      })
      return out.results
    },
    check: async (templates, allowedDeviceIds) => {
      const out = await need().deviceManager.checkDeviceTemplates.query({
        templates: [...templates],
        ...(allowedDeviceIds === undefined ? {} : { allowedDeviceIds: [...allowedDeviceIds] }),
      })
      return out.results
    },
  }
}

/** The renderer a step run is given, bound to the devices its caller may read (`undefined` = all). */
export function stepRenderer(
  door: DeviceTemplateDoor | undefined,
  allowedDeviceIds?: readonly number[],
): RenderStepTemplates | undefined {
  if (door === undefined) return undefined
  return (templates) => door.render(templates, allowedDeviceIds)
}
