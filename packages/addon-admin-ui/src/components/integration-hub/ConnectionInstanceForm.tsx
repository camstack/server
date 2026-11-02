/**
 * The connection of an addon that keeps it as an `integration-instances` record (Loki), edited
 * where the operator looks for it: the addon's own function page, in the Settings section.
 * The form is the provider's `instanceFormSchema`; the values are the record's view, so a
 * secret arrives as a "set" view and is never text. A single-instance addon with no record yet
 * shows the create form and makes the record on the first Save, named after the addon.
 *
 * Save sends only what the operator changed. A secret left alone is not in the patch, and one
 * typed as '' or the redaction token keeps the stored value (the provider's rule); a cleared
 * secret travels as the form's own clear marker.
 */
import { hydrateSchema, type ConfigUISchemaWithValues } from '@camstack/types'
import {
  Button,
  useIntegrationInstancesCreateInstance,
  useIntegrationInstancesDescribe,
  useIntegrationInstancesInstanceFormSchema,
  useIntegrationInstancesListInstances,
  useIntegrationInstancesTestInstance,
  useIntegrationInstancesUpdateInstance,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AddonFormPane,
  type AddonFormPaneHandle,
  type AddonFormPaneState,
} from '../form-builder/AddonFormPane'
import { FormSaveBar } from '../form-builder/FormSaveBar'
import {
  TestVerdictBanner,
  toTestVerdict,
  type TestVerdict,
} from '../integrations/connection-test-verdict'
import { pushToast } from '../ui/toast-bus'

export interface ConnectionInstanceFormProps {
  readonly addonId: string
  readonly displayName: string
}

const EMPTY_PENDING: AddonFormPaneState = { addonId: '', pendingKeys: [], pendingValues: {} }

export function ConnectionInstanceForm({
  addonId,
  displayName,
}: ConnectionInstanceFormProps): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const paneRef = useRef<AddonFormPaneHandle | null>(null)
  const [pending, setPending] = useState<AddonFormPaneState>(EMPTY_PENDING)
  const [verdict, setVerdict] = useState<TestVerdict | null>(null)

  const described = useIntegrationInstancesDescribe({ addonId })
  const list = useIntegrationInstancesListInstances({ addonId })
  // A single-instance addon has at most one record; several would be a list, not this form.
  const listed = list.data?.[0] ?? null
  const instanceId = listed?.id ?? null
  const answered = list.isSuccess
  const schemaQuery = useIntegrationInstancesInstanceFormSchema(
    { addonId, id: instanceId },
    { enabled: answered },
  )

  const createInstance = useIntegrationInstancesCreateInstance()
  const updateInstance = useIntegrationInstancesUpdateInstance()
  const testInstance = useIntegrationInstancesTestInstance()

  const serverValues = useMemo<Record<string, unknown>>(() => ({ ...listed?.formValues }), [listed])
  const hydrated = useMemo<ConfigUISchemaWithValues | null>(
    () => (schemaQuery.data ? hydrateSchema(schemaQuery.data, serverValues) : null),
    [schemaQuery.data, serverValues],
  )

  const persist = useCallback(
    async (patch: Record<string, unknown>): Promise<void> => {
      try {
        let id = instanceId
        if (id === null) {
          id = addonId
          await createInstance.mutateAsync({ addonId, id, name: displayName })
        }
        if (Object.keys(patch).length > 0) {
          await updateInstance.mutateAsync({ addonId, id, values: patch })
        }
        paneRef.current?.discard()
        setVerdict(null)
        void queryClient.invalidateQueries()
        pushToast({
          title: t('integrations.saved', { defaultValue: 'Configuration saved' }),
          message: displayName,
          severity: 'info',
        })
      } catch (err: unknown) {
        pushToast({
          title: t('integrations.saveFailed', { defaultValue: 'Could not save the configuration' }),
          message: `${displayName}: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'critical',
        })
      }
    },
    [addonId, createInstance, displayName, instanceId, queryClient, t, updateInstance],
  )

  const runTest = (): void => {
    setVerdict(null)
    testInstance.mutate(
      { addonId, id: instanceId, values: pending.pendingValues },
      {
        onSuccess: (result) => setVerdict(toTestVerdict(result)),
        // A transport failure of the CALL is not a verdict on the credentials.
        onError: (err) => setVerdict({ status: 'inconclusive', error: err.message }),
      },
    )
  }

  if (list.isError || schemaQuery.isError) {
    return (
      <p className="text-xs text-danger">
        {displayName}: {(list.error ?? schemaQuery.error)?.message}
      </p>
    )
  }
  if (!answered || hydrated === null) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-foreground-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('integrations.loading', { defaultValue: 'Loading…' })}
      </div>
    )
  }

  const saving = createInstance.isPending || updateInstance.isPending
  const canTest = described.data?.canTest === true
  return (
    <div className="space-y-3">
      <AddonFormPane
        ref={paneRef}
        addonId={addonId}
        schema={hydrated}
        serverValues={serverValues}
        disabled={saving}
        onImmediateSave={(_id, patch) => void persist(patch)}
        onStateChange={setPending}
      />
      {canTest && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={runTest} disabled={testInstance.isPending}>
            {testInstance.isPending ? t('integrations.testing') : t('integrations.testConnection')}
          </Button>
        </div>
      )}
      {verdict !== null && <TestVerdictBanner verdict={verdict} />}
      <FormSaveBar
        pendingCount={pending.pendingKeys.length}
        onSave={() => void persist(pending.pendingValues)}
        onDiscard={() => paneRef.current?.discard()}
        saving={saving}
      />
    </div>
  )
}
