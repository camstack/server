/**
 * `BrokerForm` — kind-driven settings form for a single broker.
 *
 * Purely schema-driven: fetches the per-kind creation/edit schema via
 * `broker.getSettingsSchema({ kind })` and renders it with the shared
 * `FormBuilder`. There is NO kind-specific branching here — the same
 * component serves every broker kind (`home-assistant`, `mqtt`, future
 * Zigbee2MQTT, …); the `kind` only selects which schema to fetch.
 *
 * Scope:
 *   BrokerForm owns the `settings` record ONLY. The human-readable
 *   broker `name` is collected one level up by `BrokerManager`'s Add
 *   dialog (on create) and is immutable on edit — so it never appears
 *   here.
 *
 * Hidden-field pruning (CRITICAL):
 *   Schemas use `showWhen` discriminators (e.g. `authKind` gating
 *   `baseUrl`/`accessToken` vs `supervisorToken`). The kind-specific
 *   validator on the provider (`settingsToAuth`) discriminates by FIELD
 *   PRESENCE, so a stale value from a deselected branch would resolve
 *   the union to the wrong auth shape. FormBuilder keeps every value the
 *   parent holds (it doesn't prune), so BrokerForm strips values whose
 *   field is currently hidden — via the shared `isFieldVisible` helper —
 *   before both `onSubmit` and the Test call.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Button,
  useBrokerGetSettingsSchema,
  useBrokerTestSettings,
  isFieldVisible,
} from '@camstack/ui-library'
import { hydrateSchema } from '@camstack/types'
import type { ConfigField, ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'
import { substituteBrokerIdPlaceholders } from './broker-form-placeholders.js'
import {
  arrangeBrokerSchema,
  countryDefaults,
  countryOfLocale,
  hasBase,
} from './broker-schema-arrange'
import { BrokerSignInPanel } from './BrokerSignInPanel'
import { Trans, useTranslation } from 'react-i18next'

export { substituteBrokerIdPlaceholders } from './broker-form-placeholders.js'

export interface BrokerFormProps {
  readonly kind: string
  /** Owning addon id for the provider that serves this `kind`. Threaded
   *  as the `{ addonId }` system-collection selector on
   *  `getSettingsSchema` / `testSettings` so the form fetches the schema
   *  and probes the connection against the OWNING provider — never the
   *  first-registered one. Omit only when the caller can't resolve it
   *  (the no-selector fallback then hits the first provider). */
  readonly addonId?: string
  /**
   * When editing an existing broker, substitute `{{brokerId}}` in info-field
   * HTML (e.g. OAuth Connect links). Kind-agnostic — Add dialog omits this.
   */
  readonly brokerId?: string
  readonly initialValues?: Record<string, unknown>
  readonly onSubmit: (settings: Record<string, unknown>) => void
  readonly onCancel: () => void
  /** Optional label for the primary action (defaults to "Save"). */
  readonly submitLabel?: string
  /** When true, disable the Save button (e.g. a parent mutation is in flight). */
  readonly disabled?: boolean
  /**
   * The kind's interactive sign-in (`signIn.basePath` from `listProviders`).
   * When present the sign-in is the primary action: the fields it fills move
   * under "Advanced" and Save becomes the secondary, manual path.
   */
  readonly signIn?: {
    readonly basePath: string
    /** Name for the broker the sign-in creates. */
    readonly name: string
    /** Re-link this broker rather than create one. */
    readonly brokerId?: string
    readonly onSignedIn: (brokerId: string) => void
  }
}

interface TestState {
  readonly ok: boolean
  readonly error?: string
}

/**
 * Flatten a schema into the leaf fields that carry a `key` + optional
 * `showWhen`. Conditions reference sibling keys WITHIN a section, so we
 * evaluate visibility per-section using that section's own field list as
 * the `allFields` context (matching how FormBuilder renders).
 */
function pruneHiddenValues(
  schema: ConfigUISchema | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema) return values
  const visibleKeys = new Set<string>()
  for (const section of schema.sections) {
    const sectionFields = section.fields as readonly ConfigField[]
    for (const field of sectionFields) {
      // Structural fields (separator/info) carry no `key`; skip them. They
      // also have no `showWhen`, so `isFieldVisible` would return true for
      // them anyway — but since they never produce a value in the `values`
      // record, omitting their (non-existent) key from `visibleKeys` prunes
      // nothing. The guard exists purely to satisfy the `string` key type.
      if (!('key' in field) || typeof field.key !== 'string') continue
      if (isFieldVisible(field, values, sectionFields)) {
        visibleKeys.add(field.key)
      }
    }
  }
  const pruned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (visibleKeys.has(key)) pruned[key] = value
  }
  return pruned
}

export function BrokerForm({
  kind,
  addonId,
  brokerId,
  initialValues,
  onSubmit,
  onCancel,
  submitLabel,
  disabled,
  signIn,
}: BrokerFormProps) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, unknown>>(initialValues ?? {})
  const [testResult, setTestResult] = useState<TestState | null>(null)

  // `getSettingsSchema` is opaque at the cap boundary (`z.unknown()`), so
  // the wire type is `unknown` — narrow to the `ConfigUISchema` shape
  // FormBuilder consumes. A null/loading schema renders no fields.
  // The `{ addonId }` selector routes the query to the OWNING provider.
  const schemaQuery = useBrokerGetSettingsSchema({
    kind,
    ...(addonId !== undefined ? { addonId } : {}),
  })
  const schema = useMemo<ConfigUISchema | undefined>(() => {
    const raw = schemaQuery.data
    if (
      raw &&
      typeof raw === 'object' &&
      'sections' in raw &&
      Array.isArray((raw as { sections: unknown }).sections)
    ) {
      const base = raw as ConfigUISchema
      const withPlaceholders =
        brokerId !== undefined ? substituteBrokerIdPlaceholders(base, brokerId) : base
      // Merge `optionsFrom` catalogs (e.g. Google `_calendarCatalog`) into
      // multiselect options — same hydrate path as getGlobalSettings.
      return arrangeBrokerSchema(hydrateSchema(withPlaceholders, values), {
        hasSignIn: signIn !== undefined,
        advancedTitle: t('brokers.brokerForm.advanced'),
      })
    }
    return undefined
  }, [schemaQuery.data, brokerId, values, signIn !== undefined, t])

  useEffect(() => {
    if (initialValues !== undefined) setValues(initialValues)
  }, [initialValues])

  // A new record starts with what the schema can derive for the operator's country.
  const country = countryOfLocale(typeof navigator === 'undefined' ? undefined : navigator.language)
  useEffect(() => {
    if (initialValues !== undefined) return
    const derived = countryDefaults(schema, country, values)
    if (Object.keys(derived).length > 0) setValues((prev) => ({ ...derived, ...prev }))
  }, [schema, country, initialValues, values])

  const testMutation = useBrokerTestSettings()

  const handleTest = async (): Promise<void> => {
    setTestResult(null)
    const settings = pruneHiddenValues(schema, values)
    try {
      const result = await testMutation.mutateAsync({
        kind,
        settings,
        ...(addonId !== undefined ? { addonId } : {}),
      })
      setTestResult(result.ok ? { ok: true } : { ok: false, error: result.error })
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleSubmit = (): void => {
    const pruned = pruneHiddenValues(schema, values)
    const { _calendarCatalog: _drop, ...rest } = pruned
    void _drop
    onSubmit(rest)
  }

  // The sign-in starts from what the operator can see: no credential, no value the sign-in itself fills.
  const signInSettings = (): Record<string, unknown> => {
    const filled = new Set<string>()
    for (const section of schema?.sections ?? []) {
      for (const field of section.fields) {
        if (hasBase(field) && field.filledBySignIn === true) filled.add(field.key)
      }
    }
    const visible = pruneHiddenValues(schema, values)
    return Object.fromEntries(Object.entries(visible).filter(([key]) => !filled.has(key)))
  }

  return (
    <div className="space-y-3">
      {signIn !== undefined && (
        <BrokerSignInPanel
          basePath={signIn.basePath}
          name={signIn.name}
          {...(signIn.brokerId !== undefined ? { brokerId: signIn.brokerId } : {})}
          getSettings={signInSettings}
          disabled={disabled === true}
          onSignedIn={signIn.onSignedIn}
        />
      )}

      {schemaQuery.isLoading && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('brokers.brokerForm.loadingSchema')}
        </div>
      )}

      {schema && <FormBuilder schema={schema} values={values} onChange={setValues} />}

      {schemaQuery.isError && (
        <div className="rounded border border-danger/30 bg-danger/5 text-danger px-3 py-2 text-[11px]">
          {t('brokers.brokerForm.failedToLoadSettingsSchema', 'Failed to load settings schema:')}{' '}
          {schemaQuery.error instanceof Error
            ? schemaQuery.error.message
            : t('brokers.brokerForm.unknownError', 'Unknown error')}
        </div>
      )}

      {!schema && !schemaQuery.isLoading && !schemaQuery.isError && (
        <div className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          <Trans
            i18nKey="brokers.brokerForm.noSchema"
            values={{ kind }}
            components={{ code: <code className="font-mono" /> }}
          />
        </div>
      )}

      {testResult && (
        <div
          className={`rounded border px-3 py-2 text-[11px] ${
            testResult.ok
              ? 'border-success/30 bg-success/5 text-success'
              : 'border-danger/30 bg-danger/5 text-danger'
          }`}
        >
          {testResult.ok
            ? t('brokers.brokerForm.connectionOk', 'Connection OK.')
            : t('brokers.brokerForm.testFailed', 'Test failed: {{value1}}', {
                value1: testResult.error ?? 'unknown error',
              })}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void handleTest()
            }}
            disabled={testMutation.isPending || !schema}
          >
            {testMutation.isPending
              ? t('brokers.brokerForm.testing', 'Testing…')
              : t('brokers.brokerForm.testConnection', 'Test connection')}
          </Button>
          <Button
            variant={signIn !== undefined ? 'outline' : 'primary'}
            size="sm"
            onClick={handleSubmit}
            disabled={!schema || disabled}
          >
            {submitLabel ?? t('common.save', 'Save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
