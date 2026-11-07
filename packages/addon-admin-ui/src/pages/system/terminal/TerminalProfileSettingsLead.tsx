/**
 * The top of a Terminal's edit dialog: the settings its profile declares. The generic form is
 * flat, and a profile's settings are a schema of their own, so they are drawn here and saved as
 * the record's `profileSettings` (a deep merge on the row).
 */
import {
  Button,
  ConfigFormBuilder,
  useInstancesOfCap,
  useIntegrationInstancesUpdateInstance,
  useTerminalSessionListProfiles,
} from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InstanceRow } from '../../../components/instances/instances-model'
import { defaultsFromSchema, profileSettingsSchema } from './terminal-instance-form'

const TERMINAL_FUNCTION_CAP = 'terminal-session'

function recordOf(values: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const value = values[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

function textOf(values: Readonly<Record<string, unknown>>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value : ''
}

export function TerminalProfileSettingsLead({ row }: { readonly row: InstanceRow }) {
  const { t } = useTranslation()
  const instances = useInstancesOfCap({ functionCap: TERMINAL_FUNCTION_CAP })
  const values = instances.data?.find((instance) => instance.id === row.id)?.formValues
  const nodeId = values === undefined ? '' : textOf(values, 'nodeId')
  const profileId = values === undefined ? '' : textOf(values, 'profileId')
  const profiles = useTerminalSessionListProfiles({ nodeId }, { enabled: nodeId !== '' })
  const schema = profileSettingsSchema(
    profiles.data?.find((profile) => profile.profileId === profileId)?.settingsSchema,
  )
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const update = useIntegrationInstancesUpdateInstance()

  useEffect(() => {
    if (values === undefined || !schema) return
    setSettings({ ...defaultsFromSchema(schema), ...recordOf(values, 'profileSettings') })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per row and schema
  }, [row.id, schema === null])

  if (!schema) return null
  return (
    <div className="space-y-2" data-testid="terminal-profile-settings">
      <ConfigFormBuilder schema={schema} values={settings} onChange={setSettings} />
      <Button
        size="sm"
        variant="outline"
        disabled={update.isPending}
        onClick={() =>
          update.mutate({ addonId: row.addonId, id: row.id, values: { profileSettings: settings } })
        }
      >
        {update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
        {t('terminalPage.saveProfileSettings', 'Save profile settings')}
      </Button>
    </div>
  )
}
