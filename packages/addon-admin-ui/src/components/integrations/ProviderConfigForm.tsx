import { collectKeychainStoredKeys, omitTransientConfig } from '@camstack/types'
import { Button, useAddonsCustom, useIntegrationsTestConnection, Input } from '@camstack/ui-library'
import { Radar } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'

/**
 * The four answers a pre-creation test can give. `validated` and `rejected` are
 * things the remote actually said; `inconclusive` and `unsupported` are things
 * nobody said, and they must NOT render as either a tick or a failure — the
 * operator has to be able to tell "your password is wrong" from "we never got
 * to ask".
 */
type TestStatus = 'validated' | 'rejected' | 'inconclusive' | 'unsupported'

interface TestResultView {
  readonly status: TestStatus
  readonly error?: string
  readonly detail?: string
}

/** Older servers answer with `success` only; treat that as the binary it was. */
function toView(result: {
  success: boolean
  error?: string
  status?: string
  detail?: string
}): TestResultView {
  const status: TestStatus =
    result.status === 'validated' ||
    result.status === 'rejected' ||
    result.status === 'inconclusive' ||
    result.status === 'unsupported'
      ? result.status
      : result.success
        ? 'validated'
        : 'rejected'
  return {
    status,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  }
}

const TONE: Record<TestStatus, string> = {
  validated: 'border-success/30 bg-success/5 text-success',
  rejected: 'border-danger/30 bg-danger/5 text-danger',
  // Deliberately NOT red: nothing failed. A neutral/attention tone, so
  // "could not check" never reads as "wrong password".
  inconclusive: 'border-warning/30 bg-warning/5 text-warning',
  unsupported: 'border-border bg-surface text-foreground-subtle',
}

interface ProviderConfigFormProps {
  addonId: string
  configSchema: ConfigUISchema | null
  /** True when the integration DECLARES a pre-creation test. When false the
   *  Test button is disabled and says why — a button that can only ever answer
   *  "cannot be tested" is worse than no button. */
  canTest?: boolean
  /** Hydrate the name field (edit-config). Wizard leaves this unset. */
  initialName?: string
  /** Hydrate the schema fields from `integrations.getSettings` (edit-config). */
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
  canTest = true,
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
  const [testResult, setTestResult] = useState<TestResultView | null>(null)

  const testMutation = useIntegrationsTestConnection({
    onSuccess: (result) => setTestResult(toView(result)),
    // A transport failure of the CALL is not a verdict on the credentials.
    onError: (err) => setTestResult({ status: 'inconclusive', error: String(err) }),
  })

  const addonsCustom = useAddonsCustom()

  const connectionValidated = !canTest || testResult?.status === 'validated'
  const nameMissing = !hideName && name.trim().length === 0
  const canGoNext = !nameMissing && connectionValidated

  const message = (view: TestResultView): string => {
    switch (view.status) {
      case 'validated':
        return view.detail
          ? `${t('integrations.connectionSuccess')} — ${view.detail}`
          : t('integrations.connectionSuccess')
      case 'rejected':
        return `${t('integrations.errorPrefix')} ${view.error ?? ''}`
      case 'inconclusive':
        return `${t('integrations.connectionInconclusive', {
          defaultValue: 'Could not be checked:',
        })} ${view.error ?? ''}`
      case 'unsupported':
        return (
          view.error ??
          t('integrations.connectionUntestable', {
            defaultValue: 'This integration cannot be tested before it is created.',
          })
        )
    }
  }

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
            setTestResult(null)
          }}
          onAction={async (action, _key, params) => {
            const result = await addonsCustom.mutateAsync({
              addonId,
              action,
              input: params ?? {},
            })
            if (canTest && result !== null && typeof result === 'object') {
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
              setTestResult(null)
              testMutation.mutate({ addonId, settings: stored })
            }
            return result
          }}
        />
      )}

      {testResult && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${TONE[testResult.status]}`}>
          {message(testResult)}
        </div>
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
          <Button
            variant="unstyled"
            onClick={() =>
              testMutation.mutate({
                addonId,
                settings: omitTransientConfig(configSchema, config),
              })
            }
            disabled={testMutation.isPending || !canTest}
            title={
              canTest
                ? undefined
                : t('integrations.connectionUntestable', {
                    defaultValue: 'This integration cannot be tested before it is created.',
                  })
            }
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testMutation.isPending ? t('integrations.testing') : t('integrations.testConnection')}
          </Button>
          {/* Next requires a validated connection test when the addon declares
              one. The server still re-runs the test inside `integrations.create`. */}
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
