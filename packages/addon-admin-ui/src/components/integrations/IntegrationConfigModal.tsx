import { useMemo, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  AddonGlobalSettingsForm,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useAddonSettingsGetIntegrationFormSchema,
  useIntegrationsGetSettings,
  useIntegrationsSetSettings,
} from '@camstack/ui-library'
import type { ConfigField, ConfigUISchema, ConfigUISchemaWithValues } from '../../types/config-ui'

import { BrokerStep } from './BrokerStep'
import { ProviderConfigForm } from './ProviderConfigForm'

type GlobalSettingsTrpc = ComponentProps<typeof AddonGlobalSettingsForm>['trpc']

type IntegrationWizardMode = 'standalone' | 'account' | 'broker'

interface IntegrationConfigModalProps {
  readonly integrationId: string
  readonly addonId: string
  readonly name: string
  /**
   * Cap kind from available-types. Kept for callers; the editor shape is
   * driven by wizard `mode`, not by this.
   */
  readonly kind: 'device-adoption' | 'device-provider'
  /** Locked wizard mode — same source as IntegrationDetail / create wizard. */
  readonly mode: IntegrationWizardMode
  /** Broker kind for a `broker` integration (e.g. `home-assistant`). */
  readonly brokerKind: string | null
  /** Whether the addon declares `connection-test` (`getAvailableTypes.canTest`). */
  readonly canTest?: boolean
  readonly trpc: GlobalSettingsTrpc
  readonly onClose: () => void
}

function collectFieldKeys(fields: readonly ConfigField[]): string[] {
  const keys: string[] = []
  for (const field of fields) {
    if (field.type === 'group') {
      keys.push(...collectFieldKeys(field.fields))
      continue
    }
    if ('key' in field && typeof field.key === 'string') keys.push(field.key)
  }
  return keys
}

function pickSchemaValues(
  schema: ConfigUISchema | null,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema) return {}
  const keys = new Set(schema.sections.flatMap((s) => collectFieldKeys(s.fields)))
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      picked[key] = settings[key]
    }
  }
  return picked
}

function stripValuesFromSchema(schema: ConfigUISchemaWithValues): ConfigUISchema {
  return {
    ...(schema.tabs ? { tabs: schema.tabs } : {}),
    sections: schema.sections.map((s) => ({
      ...s,
      fields: s.fields.map((field) => {
        if ('value' in field) {
          const { value: _value, ...rest } = field
          void _value
          return rest
        }
        return field
      }),
    })),
  } as ConfigUISchema
}

/**
 * Edit an integration's configuration. Branched on wizard `mode` (the same
 * locked model the create wizard uses), never on cap `kind`:
 *
 *  - `broker`     → re-link the integration to a broker (`BrokerStep`).
 *  - `account`    → the SAME credential form as create (`ProviderConfigForm`),
 *                   hydrated from `integrations.getSettings` and saved back
 *                   through `integrations.setSettings` (restarts the addon).
 *  - `standalone` → addon's global settings form (per-device connection).
 */
export function IntegrationConfigModal({
  integrationId,
  addonId,
  name,
  kind: _kind,
  mode,
  brokerKind,
  canTest = false,
  trpc,
  onClose,
}: IntegrationConfigModalProps) {
  void _kind
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const needsIntegrationSettings = mode === 'account' || mode === 'broker'

  const { data: settings, isLoading: settingsLoading } = useIntegrationsGetSettings(
    { id: integrationId },
    { enabled: needsIntegrationSettings },
  )
  const currentBrokerId = useMemo<string | null>(() => {
    const raw = settings?.['brokerId']
    return typeof raw === 'string' ? raw : null
  }, [settings])

  const { data: schemaWithValues, isLoading: schemaLoading } =
    useAddonSettingsGetIntegrationFormSchema(
      { addonId, nodeId: 'hub', instance: { integrationId, mode } },
      { enabled: mode === 'account' },
    )
  const configSchema = useMemo<ConfigUISchema | null>(
    () =>
      schemaWithValues ? stripValuesFromSchema(schemaWithValues as ConfigUISchemaWithValues) : null,
    [schemaWithValues],
  )

  const setSettings = useIntegrationsSetSettings()

  const persistSettings = (next: Record<string, unknown>, secretKeys?: readonly string[]): void => {
    setSettings.mutate(
      { id: integrationId, settings: next, ...(secretKeys ? { secretKeys: [...secretKeys] } : {}) },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries()
          onClose()
        },
      },
    )
  }

  const relink = (brokerId: string): void => {
    persistSettings({ brokerId })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('integrations.editConfig', { defaultValue: 'Edit configuration' })} — {name}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {mode === 'broker' ? (
            brokerKind ? (
              <div className="space-y-3">
                <p className="text-[11px] text-foreground-subtle">
                  {t('integrations.relinkBrokerHelp', {
                    defaultValue:
                      'Choose the broker this integration connects through. Picking a different broker re-points it and restarts the addon.',
                  })}
                </p>
                {currentBrokerId && (
                  <p className="text-[11px] text-foreground">
                    {t('integrations.currentBroker', { defaultValue: 'Current broker' })}:{' '}
                    <span className="font-mono text-foreground-subtle">{currentBrokerId}</span>
                  </p>
                )}
                {setSettings.isPending ? (
                  <div className="flex items-center gap-2 text-[11px] text-foreground-subtle">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('integrations.saving', { defaultValue: 'Saving…' })}
                  </div>
                ) : (
                  <BrokerStep kind={brokerKind} onResolved={relink} onBack={onClose} />
                )}
                {setSettings.isError && (
                  <p className="text-[11px] text-danger">
                    {t('integrations.relinkFailed', {
                      defaultValue: 'Failed to update broker link.',
                    })}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-danger">
                {t('integrations.noBrokerKind', {
                  defaultValue:
                    'This integration declares device-adoption but its addon manifest has no brokerKind.',
                })}
              </p>
            )
          ) : mode === 'account' ? (
            settingsLoading || schemaLoading ? (
              <div className="flex items-center gap-2 text-[11px] text-foreground-subtle">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('integrations.loading', { defaultValue: 'Loading…' })}
              </div>
            ) : (
              <ProviderConfigForm
                addonId={addonId}
                configSchema={configSchema}
                canTest={canTest}
                initialName={name}
                initialConfig={pickSchemaValues(configSchema, settings ?? {})}
                submitLabel={t('integrations.save', { defaultValue: 'Save' })}
                hideName
                onSave={({ config, secretKeys }) => persistSettings(config, secretKeys)}
                onBack={onClose}
              />
            )
          ) : (
            <AddonGlobalSettingsForm trpc={trpc} addonId={addonId} nodeId="hub" title={name} />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
