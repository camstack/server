/**
 * Per-profile settings that a Terminal instance can store and that the
 * create/edit form renders via ConfigUISchema + FormBuilder.
 *
 * Built-in profiles export a schema; custom profiles do not. Values are
 * materialised into extra argv at spawn — they never become a free-form
 * command (the profile still owns the binary).
 */
import type { ConfigUISchema } from '@camstack/types'

const GLANCES_PLUGINS = [
  { key: 'showCpu', plugin: 'cpu', label: 'CPU' },
  { key: 'showMem', plugin: 'mem', label: 'Memory' },
  { key: 'showLoad', plugin: 'load', label: 'Load' },
  { key: 'showNetwork', plugin: 'network', label: 'Network' },
  { key: 'showDiskIo', plugin: 'diskio', label: 'Disk I/O' },
  { key: 'showFs', plugin: 'fs', label: 'Filesystems' },
  { key: 'showProcessList', plugin: 'processlist', label: 'Process list' },
  { key: 'showContainers', plugin: 'containers', label: 'Containers' },
  { key: 'showSensors', plugin: 'sensors', label: 'Sensors' },
] as const

type GlancesSettingKey = (typeof GLANCES_PLUGINS)[number]['key']

export type GlancesSettings = Record<GlancesSettingKey, boolean>

function glancesBooleanField(
  key: GlancesSettingKey,
  label: string,
): {
  readonly type: 'boolean'
  readonly key: GlancesSettingKey
  readonly label: string
  readonly default: true
  readonly style: 'switch'
} {
  return { type: 'boolean', key, label, default: true, style: 'switch' }
}

export function glancesSettingsSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'glances-panels',
        title: 'Glances panels',
        description:
          'Turn off a panel to pass --disable-plugin to this Terminal only. All on is the measured default (~1% of one core at the camera grid).',
        columns: 2,
        fields: GLANCES_PLUGINS.map((plugin) => glancesBooleanField(plugin.key, plugin.label)),
      },
    ],
  }
}

export function settingsSchemaForProfile(profileId: string): ConfigUISchema | null {
  if (profileId === 'glances') return glancesSettingsSchema()
  return null
}

export function glancesSettingsToArgs(settings: GlancesSettings): readonly string[] {
  const disabled = GLANCES_PLUGINS.filter((plugin) => settings[plugin.key] === false).map(
    (plugin) => plugin.plugin,
  )
  if (disabled.length === 0) return []
  return ['--disable-plugin', disabled.join(',')]
}

export function sanitizeProfileSettings(profileId: string, raw: unknown): Record<string, unknown> {
  if (profileId !== 'glances') return {}
  const bag =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: GlancesSettings = {
    showCpu: true,
    showMem: true,
    showLoad: true,
    showNetwork: true,
    showDiskIo: true,
    showFs: true,
    showProcessList: true,
    showContainers: true,
    showSensors: true,
  }
  for (const plugin of GLANCES_PLUGINS) {
    const value = bag[plugin.key]
    if (typeof value === 'boolean') out[plugin.key] = value
  }
  return out
}

export function profileSettingsToArgs(
  profileId: string,
  settings: Record<string, unknown>,
): readonly string[] {
  if (profileId !== 'glances') return []
  return glancesSettingsToArgs(sanitizeProfileSettings(profileId, settings) as GlancesSettings)
}

export function spawnArgsForInstance(input: {
  readonly profileId: string
  readonly instanceArgs: readonly string[]
  readonly profileArgs: readonly string[]
  readonly profileSettings: Record<string, unknown>
}): readonly string[] | undefined {
  const extra = profileSettingsToArgs(input.profileId, input.profileSettings)
  if (input.instanceArgs.length > 0) return [...input.instanceArgs, ...extra]
  if (extra.length > 0) return [...input.profileArgs, ...extra]
  return undefined
}

export function defaultsFromSettingsSchema(schema: ConfigUISchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if ('key' in field && 'default' in field && field.default !== undefined) {
        out[field.key] = field.default
      }
    }
  }
  return out
}
