/**
 * The "Name on <platform>" field of the device Export tab, DERIVED from the `device-export` cap
 * (D1049): one text field per enabled export instance, read from
 * `listExposedDevices().exposedName` and written through `setExposedName`. No exporter writes
 * this field by hand; every exporter gets it the same way.
 *
 * Field key: `export-name:<addonId>:<instanceId>`. The patch router splits these keys off before
 * the exporter's own `applyDeviceSettingsPatch` sees the rest.
 */
import { ExportNameRefusedError, type IDeviceExportProvider } from '@camstack/types'
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

type ExportInstanceRow = Awaited<ReturnType<ExportNameProvider['listInstances']>>[number]

function nameField(addonId: string, instance: ExportInstanceRow, value: string): unknown {
  const rule = instance.nameRule === undefined ? '' : ` ${instance.nameRule}`
  return {
    type: 'text',
    key: fieldKey(addonId, instance.instanceId),
    label: `Name on ${instance.name}`,
    description: `What ${instance.name} calls this device. Leave empty to use the device name.${rule} Renaming updates the same device there; it is never added again.`,
    placeholder: 'Device name',
    value,
  }
}

/**
 * The section of `instanceId`: the one whose id is the instance id or ends with `:<instanceId>`
 * (one section per instance), else the exporter's only section (one section for every instance).
 * With several sections and none naming the instance, the first holds it.
 */
function sectionIndexFor(sections: ContributionShape['sections'], instanceId: string): number {
  const named = sections.findIndex((s) => s.id === instanceId || s.id.endsWith(`:${instanceId}`))
  return named >= 0 ? named : 0
}

/**
 * Add one name field per enabled instance to the exporter's own contribution — exposed or not,
 * so the name can be set in the same save that turns Expose on (the names are applied first).
 * Without a contribution there is no Export panel to hold the field, so nothing is added (the
 * device is not exported by this addon).
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
    const target = sections[sectionIndexFor(sections, instance.instanceId)]
    target?.fields.unshift(nameField(addonId, instance, row?.exposedName ?? ''))
  }
  return { ...contribution, sections }
}

/**
 * Split the derived name keys of `addonId` from the rest of a patch. A blank string or null
 * clears the name; any other non-string is refused by name, never read as "clear".
 */
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
    if (value !== null && typeof value !== 'string') {
      throw new ExportNameRefusedError(instanceId, 'The name must be text.')
    }
    names.push({ instanceId, name: value === null || value.trim().length === 0 ? null : value })
  }
  return { names, rest }
}

/**
 * Write the names through the cap, all or none: every name is checked first (`dryRun`), so one
 * refusal (`export-name-refused: …`) propagates before ANY is written.
 */
export async function applyExportNames(
  provider: Pick<ExportNameProvider, 'setExposedName'>,
  deviceId: number,
  names: readonly ExportNameEdit[],
): Promise<void> {
  const calls = names.map((edit) => ({
    instanceId: edit.instanceId,
    deviceId: String(deviceId),
    name: edit.name,
  }))
  for (const call of calls) await provider.setExposedName({ ...call, dryRun: true })
  for (const call of calls) await provider.setExposedName(call)
}
