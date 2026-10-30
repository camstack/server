import { DeviceType } from '@camstack/types'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LogStream,
  useDeviceManagerCreateDevice,
  useDeviceManagerGetCreationSchema,
  useDeviceManagerProviderCreationType,
  useDeviceManagerTestCreationField,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, Loader2, ScrollText, Wifi } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { ConfigField, ConfigUISchema, FieldProbeResult } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'
import { useProbeAll } from '../form-builder/useProbeAll'

/**
 * Walk the schema (including nested groups) and return every required
 * field key. Used to gate Save until every required field is non-empty
 * so the operator gets immediate feedback instead of a server-side
 * tRPC validation error after click.
 */
function collectRequiredKeys(fields: readonly ConfigField[]): string[] {
  const keys: string[] = []
  for (const field of fields) {
    if ('required' in field && field.required === true && 'key' in field && field.key) {
      keys.push(field.key)
    }
    if (field.type === 'group' && 'fields' in field) {
      keys.push(...collectRequiredKeys(field.fields))
    }
  }
  return keys
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  return false
}

/**
 * Walk the schema (including nested groups) and seed an initial values
 * map from every field's `default`. Without this, fields that ship
 * with a default (e.g. Reolink `username: 'admin'`) display the
 * default in the input but `formValues[key]` stays `undefined` →
 * required-validation reports them as missing even though the operator
 * sees a populated input. The form-builder's onChange path only
 * publishes a value once the user interacts with the field; this hook
 * makes the schema's `default` round-trip into the validation source
 * of truth from frame 1.
 */
function collectSchemaDefaults(
  fields: readonly ConfigField[],
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const field of fields) {
    if (field.type === 'group' && 'fields' in field) {
      collectSchemaDefaults(field.fields, out)
      continue
    }
    if ('key' in field && field.key && 'default' in field && field.default !== undefined) {
      out[field.key] = field.default
    }
  }
  return out
}

/**
 * Generate a fresh correlation id used to scope a single Add-Device
 * dialog session. Falls back to a Math.random combo on platforms
 * without `crypto.randomUUID` (very old browsers — defensive).
 */
function generateProbeRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `probe-${crypto.randomUUID()}`
  }
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

interface AddDeviceDialogProps {
  open: boolean
  integrationId: string
  addonId: string
  onClose: () => void
}

export function AddDeviceDialog({ open, integrationId, addonId, onClose }: AddDeviceDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [showLogs, setShowLogs] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // One correlation id per dialog open. Reset on every open so each
  // session has a clean scope; providers tag their probe loggers with
  // it so the LogStream below shows ONLY the lines from this test run.
  const [probeRequestId, setProbeRequestId] = useState(generateProbeRequestId)

  // Which DeviceType this provider creates (Camera for Reolink/ONVIF, Container
  // for Gree, Hub for Ecowitt). Resolve it FIRST so the creation-schema query
  // fires with the right type — hardcoding Camera made non-camera providers
  // ("provider not ready / does not support manual creation") fail.
  const creationTypeQuery = useDeviceManagerProviderCreationType({ addonId }, { enabled: open })
  const creationType = creationTypeQuery.data?.deviceType ?? null

  const schemaQuery = useDeviceManagerGetCreationSchema(
    { addonId, type: creationType ?? DeviceType.Camera },
    { enabled: open && creationTypeQuery.isSuccess && creationType !== null },
  )

  const schema = (schemaQuery.data ?? null) as ConfigUISchema | null

  useEffect(() => {
    if (open) {
      // Seed from schema defaults so prefilled fields (e.g. username='admin')
      // count as filled by the required-validation gate.
      const seed = schema ? collectSchemaDefaults(schema.sections.flatMap((s) => s.fields)) : {}
      setFormValues(seed)
      setProbeRequestId(generateProbeRequestId())
      setShowLogs(false)
      setSubmitError(null)
    }
  }, [open, integrationId, schema])

  // Inject the correlation id into the form snapshot sent on every
  // probe call. Underscore-prefixed key signals "transient,
  // not-a-config-field" — providers can ignore it. Reolink reads it
  // out and binds the lib logger via withTags({ requestId }).
  const probeFormValues = useMemo(
    () => ({ ...formValues, _probeRequestId: probeRequestId }),
    [formValues, probeRequestId],
  )

  const createMutation = useDeviceManagerCreateDevice({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })

  const testFieldMutation = useDeviceManagerTestCreationField()
  const onTestField = useCallback(
    async (key: string, value: unknown): Promise<FieldProbeResult> => {
      // Auto-open the logs panel on first test click so operators see
      // socket / handshake lines stream as the probe runs — they stay
      // closed otherwise to keep the dialog compact.
      setShowLogs(true)
      const result = (await testFieldMutation.mutateAsync({
        addonId,
        type: creationType ?? DeviceType.Camera,
        key,
        value,
        formValues: probeFormValues,
      })) as FieldProbeResult
      // Auto-apply provider-suggested field values (e.g. populate `name`
      // with the autodetected camera model after a host probe). Merges
      // ONLY into fields the operator hasn't filled yet — never
      // overwrites user input. The provider is responsible for what
      // makes sense to suggest; the dialog just drops the values into
      // the working snapshot.
      if (result.status === 'ok' && result.suggestedValues) {
        setFormValues((prev) => {
          let changed = false
          const next = { ...prev }
          for (const [k, v] of Object.entries(result.suggestedValues ?? {})) {
            if (isEmptyValue(prev[k]) && !isEmptyValue(v)) {
              next[k] = v
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
      return result
    },
    [testFieldMutation, addonId, probeFormValues, creationType],
  )

  const { testAllStatus, hasProbeFields, probeResults, handleTestAll, clearProbeResult } =
    useProbeAll(schema ?? { sections: [] }, formValues, onTestField)

  async function handleSave(andNew: boolean) {
    setSubmitError(null)
    try {
      await createMutation.mutateAsync({
        addonId,
        type: creationType ?? DeviceType.Camera,
        config: formValues,
        integrationId,
      })
      if (andNew) {
        // Re-seed with schema defaults — same reasoning as the open-time effect.
        const seed = schema ? collectSchemaDefaults(schema.sections.flatMap((s) => s.fields)) : {}
        setFormValues(seed)
      } else {
        onClose()
      }
    } catch (err) {
      // Surface the server-side validation / probe error inline so the
      // operator gets a visible reason for the failed Save instead of
      // a console-only TRPCClientError.
      setSubmitError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!open) return null

  // Gate Save on every `required` field in the schema being non-empty.
  // Server-side validation still runs (and surfaces via `submitError`),
  // but clicking Save with an obviously-empty Password is wasted UX.
  const requiredKeys = collectRequiredKeys((schema?.sections ?? []).flatMap((s) => s.fields))
  const missingRequired = requiredKeys.filter((k) => isEmptyValue(formValues[k]))
  const isFormValid = missingRequired.length === 0
  // Busy while resolving the provider's creatable type, then its creation form.
  const isBusy = creationTypeQuery.isLoading || (creationType !== null && schemaQuery.isLoading)
  // Real error: provider reports no creatable type, or its schema fails/comes
  // back empty. (A null type = manual creation genuinely unsupported.)
  const hasError =
    creationTypeQuery.isError ||
    (creationTypeQuery.isSuccess && creationType === null) ||
    schemaQuery.isError ||
    (schemaQuery.isSuccess && schema === null)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent width="lg" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('integrations.addDevice')}</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {isBusy ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : hasError ? (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p className="text-xs font-medium text-destructive">
                  {t('integrations.addDeviceDialog.providerUnavailable', 'Provider unavailable')}
                </p>
                <p className="text-xs text-foreground-subtle">
                  <Trans
                    i18nKey="integrations.addDeviceDialog.notReady"
                    values={{ addonId }}
                    components={{ mono: <span className="font-mono" /> }}
                  />
                </p>
              </div>
            </div>
          ) : (
            <FormBuilder
              schema={schema!}
              values={formValues}
              onChange={setFormValues}
              onTestField={onTestField}
              probeResults={probeResults}
              onClearProbe={clearProbeResult}
            />
          )}
        </DialogBody>

        {/* Live test logs — collapsed by default, auto-opens on first
            test click. Filtered on (addonId, requestId) so it shows
            ONLY this dialog's probe traffic. Empty until the provider
            tags its probe logger with `requestId` (Reolink does;
            other providers will be added incrementally). */}
        {!hasError && !isBusy && (
          <div className="border-t border-border bg-surface/50 shrink-0">
            <button
              type="button"
              onClick={() => setShowLogs((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-[11px] text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              <span className="flex items-center gap-2">
                <ScrollText className="h-3.5 w-3.5" />
                {t('integrations.addDeviceDialog.testLogs', 'Test logs')}
                <span className="font-mono text-[9px] opacity-60">
                  {probeRequestId.slice(0, 14)}
                </span>
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${showLogs ? 'rotate-180' : ''}`}
              />
            </button>
            {showLogs && (
              <div className="border-t border-border max-h-64 overflow-hidden">
                <LogStream
                  addonId={addonId}
                  requestId={probeRequestId}
                  limit={50}
                  maxHeight="max-h-64"
                  showFilters={false}
                  showScope={false}
                  className="border-0 rounded-none"
                />
              </div>
            )}
          </div>
        )}

        {/* Validation / submit error banner — visible above the footer
            so a missing-required field or a server-side reject (e.g.
            `Password is required`) is impossible to miss. */}
        {!hasError && !isBusy && (submitError || missingRequired.length > 0) && (
          <div className="border-t border-destructive/30 bg-destructive/5 px-3 py-2 shrink-0">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
              <p className="text-[11px] text-destructive">
                {submitError
                  ? submitError
                  : t('integrations.addDeviceDialog.required', 'Required: {{value1}}', {
                      value1: missingRequired.join(', '),
                    })}
              </p>
            </div>
          </div>
        )}

        {/* Footer */}
        <DialogFooter className="justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground-subtle hover:text-foreground transition-colors"
            >
              {t('integrations.cancel')}
            </button>
            {!hasError && hasProbeFields && (
              <button
                type="button"
                onClick={handleTestAll}
                disabled={testAllStatus === 'testing'}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
              >
                {testAllStatus === 'testing' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wifi className="h-3.5 w-3.5" />
                )}
                {t('integrations.addDeviceDialog.testAll', 'Test All')}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSave(true)}
              disabled={hasError || !isFormValid || createMutation.isPending}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
            >
              {t('integrations.saveAndNew')}
            </button>
            <button
              onClick={() => handleSave(false)}
              disabled={hasError || !isFormValid || createMutation.isPending}
              className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground shadow-sm disabled:opacity-50"
            >
              {createMutation.isPending ? t('integrations.saving') : t('integrations.save')}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
