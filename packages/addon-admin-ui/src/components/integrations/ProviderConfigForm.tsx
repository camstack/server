import { collectKeychainStoredKeys, omitTransientConfig } from '@camstack/types'
import { Button, useAddonsCustom, Input } from '@camstack/ui-library'
import { Radar } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'

interface ProviderConfigFormProps {
  addonId: string
  configSchema: ConfigUISchema | null
  /** Hydrate the name field (edit-config). Wizard leaves this unset. */
  initialName?: string
  /** Hydrate the schema fields from the instance record (edit-config). */
  initialConfig?: Record<string, unknown>
  /** Primary-button label. Wizard keeps the default ("Next"). */
  submitLabel?: string
  /**
   * Edit-config hides the name field: rename is not this modal's job, and
   * showing an editable name that `setSettings` cannot persist is a lie.
   * Wizard leaves this unset.
   */
  hideName?: boolean
  /** The save is in flight: the primary button is disabled and says so. */
  saving?: boolean
  /** `secretKeys`: the keys the schema declares secret by type — the hub keeps
   *  their values in the keychain, not the integration's settings (D787). */
  /** Opens a network scan scoped to this integration; shown only when set. */
  onScan?: () => void
  onSave: (config: {
    name: string
    config: Record<string, unknown>
    secretKeys: readonly string[]
  }) => void
  onBack: () => void
}

export function ProviderConfigForm({
  addonId,
  configSchema,
  initialName,
  initialConfig,
  submitLabel,
  hideName = false,
  saving = false,
  onScan,
  onSave,
  onBack,
}: ProviderConfigFormProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(initialName ?? '')
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig ?? {})

  const addonsCustom = useAddonsCustom()

  const nameMissing = !hideName && name.trim().length === 0
  const canGoNext = !nameMissing

  return (
    <div className="space-y-4">
      {!hideName && (
        <div>
          <label
            htmlFor="integration-name"
            className="block text-[11px] font-medium text-foreground mb-1"
          >
            {t('integrations.integrationName')}
          </label>
          <Input
            id="integration-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('integrations.integrationNamePlaceholder')}
            aria-invalid={nameMissing}
            aria-describedby={nameMissing ? 'integration-name-error' : undefined}
            className={`w-full rounded-lg border bg-surface px-3 py-2 text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none ${
              nameMissing
                ? 'border-danger focus:border-danger'
                : 'border-border focus:border-primary/50'
            }`}
          />
          {nameMissing && (
            <p
              id="integration-name-error"
              data-testid="integration-name-error"
              className="mt-1 text-xs text-danger"
            >
              {t('integrations.nameRequired', 'Name is required')}
            </p>
          )}
        </div>
      )}

      {configSchema && (
        <FormBuilder
          schema={configSchema}
          values={config}
          onChange={(next) => {
            setConfig(next)
          }}
          onAction={async (action, _key, params) => {
            const result = await addonsCustom.mutateAsync({
              addonId,
              action,
              input: params ?? {},
            })
            if (result !== null && typeof result === 'object') {
              const record = result as Record<string, unknown>
              const completesLogin =
                typeof record['token'] === 'string' ||
                typeof record['sslCertificate'] === 'string' ||
                typeof record['host'] === 'string'
              if (!completesLogin) return result
              const next: Record<string, unknown> = { ...config }
              for (const [key, value] of Object.entries(record)) {
                if (typeof value === 'string' && key !== 'summary') next[key] = value
              }
              const stored = omitTransientConfig(configSchema, next)
              setConfig(stored)
            }
            return result
          }}
        />
      )}

      <div className="flex items-center justify-between pt-2">
        <Button
          variant="unstyled"
          onClick={onBack}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground-subtle hover:text-foreground transition-colors"
        >
          {t('integrations.back')}
        </Button>
        <div className="flex items-center gap-2">
          {onScan && (
            <Button variant="outline" size="sm" onClick={onScan} data-testid="integration-scan">
              <Radar className="h-3.5 w-3.5" />
              {t('integrations.scanFromForm', 'Scan the network')}
            </Button>
          )}
          {/* The server tests the connection inside `integrations.create`
              (`integration-instances.testInstance`) and refuses a rejected one. */}
          <div className="flex flex-col items-end gap-1">
            {nameMissing && (
              <p data-testid="integration-name-submit-error" className="text-xs text-danger">
                {t('integrations.nameRequiredSubmit', 'Enter a name before continuing.')}
              </p>
            )}
            <Button
              variant="unstyled"
              onClick={() => {
                if (nameMissing) return
                onSave({
                  name,
                  config: omitTransientConfig(configSchema, config),
                  secretKeys: [...collectKeychainStoredKeys(configSchema)],
                })
              }}
              disabled={!canGoNext || saving}
              className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground shadow-sm disabled:opacity-50"
            >
              {saving
                ? t('integrations.saving', { defaultValue: 'Saving…' })
                : (submitLabel ?? t('integrations.forward'))}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
