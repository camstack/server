/**
 * The "Name on <platform>" field of the device Export tab, DERIVED from the `device-export` cap
 * (D1049): one text field per export instance that exposes the device, read from
 * `listExposedDevices().exposedName` and written through `setExposedName`. No exporter writes
 * this field by hand; every exporter gets it the same way.
 *
 * Field key: `export-name:<addonId>:<instanceId>`. The patch router splits these keys off before
 * the exporter's own `applyDeviceSettingsPatch` sees the rest.
 */
import type { IDeviceExportProvider } from '@camstack/types'
import type { ContributionShape } from './device-meta-types.js'

export const EXPORT_NAME_FIELD_PREFIX = 'export-name:'

/** The part of a `device-export` provider the derived field reads and writes. */
export type ExportNameProvider = Pick<
  IDeviceExportProvider,
  'listInstances' | 'listExposedDevices' | 'setExposedName'
>

export interface ExportNameEdit {
  readonly instanceId: string
  readonly name: string | null
}

export interface SplitExportNamePatch {
  readonly names: readonly ExportNameEdit[]
  readonly rest: Record<string, unknown>
}

const fieldKey = (addonId: string, instanceId: string): string =>
  `${EXPORT_NAME_FIELD_PREFIX}${addonId}:${instanceId}`

function nameField(addonId: string, instanceId: string, platform: string, value: string): unknown {
  return {
    type: 'text',
    key: fieldKey(addonId, instanceId),
    label: `Name on ${platform}`,
    description:
      'What this platform calls the device. Leave empty to use the device name. Renaming updates the same device there; it is never added again.',
    placeholder: 'Device name',
    value,
  }
}

/** The section of `instanceId`: the one whose id names it, else the first. */
function sectionIndexFor(sections: ContributionShape['sections'], instanceId: string): number {
  const named = sections.findIndex((s) => s.id === instanceId || s.id.endsWith(`:${instanceId}`))
  return named >= 0 ? named : 0
}

/**
 * Add one name field per enabled instance that exposes `deviceId` to the exporter's own
 * contribution. Without a contribution there is no Export panel to hold the field, so nothing is
 * added (the device is not exported by this addon).
 */
export async function withExportNameFields(
  contribution: ContributionShape | null,
  provider: ExportNameProvider,
  addonId: string,
  deviceId: number,
): Promise<ContributionShape | null> {
  if (contribution === null || contribution.sections.length === 0) return contribution
  const id = String(deviceId)
  const instances = (await provider.listInstances()).filter((i) => i.enabled)
  const sections = contribution.sections.map((s) => ({
    ...s,
    fields: [...s.fields],
  }))
  for (const instance of instances) {
    const exposed = await provider.listExposedDevices({
      instanceId: instance.instanceId,
    })
    const row = exposed.find((d) => d.deviceId === id)
    if (row === undefined) continue
    const target = sections[sectionIndexFor(sections, instance.instanceId)]
    target?.fields.unshift(
      nameField(addonId, instance.instanceId, instance.name, row.exposedName ?? ''),
    )
  }
  return { ...contribution, sections }
}

/** Split the derived name keys of `addonId` from the rest of a patch. */
export function splitExportNamePatch(
  addonId: string,
  patch: Readonly<Record<string, unknown>>,
): SplitExportNamePatch {
  const prefix = `${EXPORT_NAME_FIELD_PREFIX}${addonId}:`
  const names: ExportNameEdit[] = []
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith(prefix)) {
      rest[key] = value
      continue
    }
    const instanceId = key.slice(prefix.length)
    const name = typeof value === 'string' && value.trim().length > 0 ? value : null
    names.push({ instanceId, name })
  }
  return { names, rest }
}

/** Write each name through the cap; a refusal (`export-name-refused: …`) propagates to the caller. */
export async function applyExportNames(
  provider: Pick<ExportNameProvider, 'setExposedName'>,
  deviceId: number,
  names: readonly ExportNameEdit[],
): Promise<void> {
  for (const edit of names) {
    await provider.setExposedName({
      instanceId: edit.instanceId,
      deviceId: String(deviceId),
      name: edit.name,
    })
  }
}
