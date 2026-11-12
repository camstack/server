/**
 * Create or edit one `integration-instances` record. The form is the provider's own
 * `instanceFormSchema`, drawn by the controlled `ConfigFormBuilder`; the values start as the
 * record's view, so a stored secret is a "set" view and never text.
 *
 * A provider that declares kinds adds a kind picker on create (only when there is a choice), a
 * kind with `signIn` offers the interactive sign-in panel (the same one a broker uses), and a
 * kind with `connectPath` a Connect button on an existing record. When the provider allows it,
 * Add can restore a removed instance under its old id.
 *
 * Save sends only what the operator changed (`diffInstanceValues`): an untouched secret is not in
 * the patch, a typed one replaces the stored value and a cleared one travels as the field's own
 * clear marker. A new record is created under its id first, then patched with the typed keys.
 */
import {
  type ConfigSelectField,
  hydrateSchema,
  type IntegrationInstance,
  type IntegrationInstanceDescription,
} from '@camstack/types'
import {
  Button,
  ConfigFormBuilder,
  ItemFormDialog,
  pickedValues,
  useSystem,
} from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Loader2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { fillBrokerConnectPath, startServerNavigation } from '../../lib/broker-oauth-popup'
import type { ConfigUISchema } from '../../types/config-ui'
import { BrokerSignInPanel } from '../brokers/BrokerSignInPanel'
import { FormBuilder } from '../form-builder/FormBuilder'
import {
  TestVerdictBanner,
  toTestVerdict,
  type TestVerdict,
} from '../integrations/connection-test-verdict'
import { pushToast } from '../ui/toast-bus'
import { kindWidget, withoutFields } from './kind-widgets'
import { ManyPickLabels } from './ManyPickLabels'
import { manyCreateItems, pickManyField, withMultiplePick } from './pick-many'
import { HOLDER_QUERY_KEY } from './use-instances-data'
import {
  checkTypedId,
  diffInstanceValues,
  effectiveInstanceValues,
  createLabel,
  findKind,
  formStartValues,
  mintInstanceId,
  uiProposesInstanceId,
  needsKindPicker,
  randomHex8,
  type TypedIdRuleFor,
} from './instances-model'

const IDENTITY_NAME = 'name'
const IDENTITY_KIND = 'kind'
const IDENTITY_RESTORE = 'restore'
const IDENTITY_RESTORE_ID = 'restoreId'
const IDENTITY_TYPED_ID = 'typedId'

export interface InstanceEditorDialogProps {
  readonly addonId: string
  readonly providerName: string
  readonly description: IntegrationInstanceDescription
  /** The record being edited, or null for a new one. */
  readonly instance: IntegrationInstance | null
  readonly onClose: () => void
  /** The record exists: created, edited or signed in. A wizard that needs the id uses this. */
  readonly onSaved?: (id: string) => void
  /** A block shown above the form (setup, pairing) — only for a record that exists. */
  readonly lead?: ReactNode
  /**
   * The kinds that ask the operator for the new record's id. Absent (or undefined for the kind
   * being created) means the provider or the UI mints it.
   */
  readonly typedId?: TypedIdRuleFor
}

const NO_VALUES: Readonly<Record<string, unknown>> = {}

export function InstanceEditorDialog({
  addonId,
  providerName,
  description,
  instance,
  onClose,
  onSaved,
  lead,
  typedId,
}: InstanceEditorDialogProps): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const instanceId = instance?.id ?? null

  const kinds = description.kinds ?? []
  // A provider with several kinds (storage: one per place) is not what the operator is adding:
  // the kind is, so the default name and the title say the kind (D1013).
  const startKindId = instance?.kind ?? kinds[0]?.id
  const addedLabel = createLabel(description, findKind(description, startKindId), providerName)
  const [identity, setIdentity] = useState<Record<string, unknown>>({
    [IDENTITY_NAME]: instance?.name ?? addedLabel,
    [IDENTITY_KIND]: instance?.kind ?? kinds[0]?.id ?? '',
    [IDENTITY_RESTORE]: false,
    [IDENTITY_RESTORE_ID]: '',
    [IDENTITY_TYPED_ID]: '',
  })
  // The default name follows the chosen kind while the operator has not typed their own.
  const autoName = useRef(addedLabel)
  const chosenKind = identity[IDENTITY_KIND]
  useEffect(() => {
    if (instance !== null || typeof chosenKind !== 'string') return
    const label = createLabel(description, findKind(description, chosenKind), providerName)
    const previous = autoName.current
    autoName.current = label
    setIdentity((prev) =>
      prev[IDENTITY_NAME] === previous ? { ...prev, [IDENTITY_NAME]: label } : prev,
    )
  }, [chosenKind, description, instance, providerName])
  const textOf = (key: string): string => {
    const v = identity[key]
    return typeof v === 'string' ? v.trim() : ''
  }
  const name = textOf(IDENTITY_NAME)
  const kindId = textOf(IDENTITY_KIND)
  const kind = findKind(description, kindId === '' ? undefined : kindId)
  const restoring = identity[IDENTITY_RESTORE] === true
  const restoreId = textOf(IDENTITY_RESTORE_ID)
  // A sign-in mints the record under a fresh id, so "restore under its old id" does not apply.
  const canRestore =
    instance === null && description.allowRestoreId === true && kind?.signIn === undefined
  const restoreMissing = canRestore && restoring && restoreId === ''
  // The operator names the record only on create, and not when a sign-in mints it or a restore
  // brings the old id back.
  const idRule =
    instance === null && kind?.signIn === undefined && !(canRestore && restoring)
      ? typedId?.(kindId === '' ? undefined : kindId)
      : undefined
  const typed = textOf(IDENTITY_TYPED_ID)
  const typedState = idRule === undefined ? 'ok' : checkTypedId(idRule, typed)
  const [values, setValues] = useState<Record<string, unknown>>({
    ...(instance?.formValues ?? NO_VALUES),
  })
  const [error, setError] = useState<string | null>(null)
  const identitySchema = useMemo<ConfigUISchema>(
    () => ({
      sections: [
        {
          id: 'instance-identity',
          title: t('providerInstances.identity', 'Identity'),
          columns: 1,
          fields: [
            ...(instance === null && needsKindPicker(description)
              ? [
                  {
                    type: 'select' as const,
                    key: IDENTITY_KIND,
                    label: t('providerInstances.colKind', 'Kind'),
                    options: kinds.map((k) => ({
                      value: k.id,
                      label: k.label,
                    })),
                  },
                ]
              : []),
            {
              type: 'text' as const,
              key: IDENTITY_NAME,
              label: t('providerInstances.colName', 'Name'),
              required: true,
            },
            ...(idRule !== undefined
              ? [
                  {
                    type: 'text' as const,
                    key: IDENTITY_TYPED_ID,
                    label: t('providerInstances.typedId', 'Id'),
                    required: true,
                    description:
                      typedState === 'invalid'
                        ? t(
                            'providerInstances.typedIdInvalid',
                            'Lowercase letters, digits and dashes, starting with a letter or digit (up to 64).',
                          )
                        : t(
                            'providerInstances.typedIdHint',
                            'Chosen once; it cannot be changed after the record is created.',
                          ),
                  },
                ]
              : []),
            ...(canRestore
              ? [
                  {
                    type: 'boolean' as const,
                    key: IDENTITY_RESTORE,
                    label: t('providerInstances.restore', 'Restore under its old id'),
                    description: t(
                      'providerInstances.restoreHint',
                      'Re-adding something that was removed under its original id keeps everything that points at it working.',
                    ),
                  },
                  {
                    type: 'text' as const,
                    key: IDENTITY_RESTORE_ID,
                    label: t('providerInstances.originalId', 'Original id'),
                    required: true,
                    showWhen: { field: IDENTITY_RESTORE, equals: true },
                  },
                ]
              : []),
          ],
        },
      ],
    }),
    [canRestore, description, idRule, instance, kinds, t, typedState],
  )
  const [verdict, setVerdict] = useState<TestVerdict | null>(null)

  // The create form is the chosen kind's; an existing record's form is its own.
  const formKind = instanceId === null && kindId !== '' ? kindId : undefined
  const schemaQuery = useQuery({
    queryKey: ['provider-instance-form', addonId, instanceId, formKind ?? null],
    queryFn: () =>
      system.trpcClient.integrationInstances.instanceFormSchema.query({
        addonId,
        id: instanceId,
        ...(formKind !== undefined ? { kind: formKind } : {}),
      }),
  })
  // The record body also holds the on/off switch; the form starts without it unless the form
  // itself owns a field of that name.
  const stored = useMemo(
    () => (instance === null ? NO_VALUES : formStartValues(instance.formValues, schemaQuery.data)),
    [instance, schemaQuery.data],
  )
  const edited = useMemo(
    () => formStartValues(values, schemaQuery.data),
    [values, schemaQuery.data],
  )
  // A create form whose picker declares `pickManyOnCreate` ticks several values: one record each.
  const manyField = instance === null ? pickManyField(schemaQuery.data) : null
  const manyKey = manyField?.key
  const formSchema = useMemo(
    () =>
      schemaQuery.data && manyKey !== undefined
        ? withMultiplePick(schemaQuery.data, manyKey)
        : schemaQuery.data,
    [schemaQuery.data, manyKey],
  )
  const picked = manyField === null ? [] : pickedValues(values[manyField.key])
  const many = picked.length > 1
  // The candidate names, from the query that fills the picker (ManyPickLabels); none = named by value.
  const [pickLabels, setPickLabels] = useState<ReadonlyMap<string, string>>(() => new Map())
  const onPickLabels = useCallback((labels: ReadonlyMap<string, string>) => {
    setPickLabels(labels)
  }, [])
  const hydrated = useMemo(
    () => (formSchema ? hydrateSchema(formSchema, { ...stored }) : null),
    [formSchema, stored],
  )
  // The provider ANSWERED with no form for this record: say so (name and switch are still editable),
  // never a spinner that does not end.
  const noForm = schemaQuery.isSuccess && !schemaQuery.data

  // Connection widgets of the kind draw some fields themselves (a path browser); the plain form
  // then leaves those out. An id this build does not know draws nothing.
  const connectionWidgets = (kind?.widgets ?? []).flatMap((w) => {
    const widget = w.placement === 'connection' ? kindWidget(w.id) : null
    return widget === null ? [] : [{ id: w.id, widget }]
  })
  const widgetOwnedKeys =
    hydrated === null
      ? []
      : connectionWidgets.flatMap(({ widget }) => widget.ownedKeys(hydrated, values))

  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      const client = system.trpcClient.integrationInstances
      const diff = diffInstanceValues(stored, edited)
      // One tick is an ordinary create of one record holding that value.
      const patch =
        manyField !== null && picked.length === 1 ? { ...diff, [manyField.key]: picked[0] } : diff
      // Several ticks: one record per value. A typed id and "restore under its old id" each name
      // ONE record, so neither applies here (the dialog hides both): every record gets the id the
      // provider or the UI mints, exactly as a create without a typed id does.
      if (instance === null && manyField !== null && many) {
        const items = manyCreateItems({
          key: manyField.key,
          picked,
          labels: pickLabels,
          typedName: name,
          values: patch,
        })
        let lastId = ''
        for (const [index, item] of items.entries()) {
          try {
            const created = await client.createInstance.mutate({
              addonId,
              name: item.name,
              ...(uiProposesInstanceId(description, kind)
                ? { id: mintInstanceId(description.instanceMode, addonId, randomHex8) }
                : {}),
              ...(kindId !== '' ? { kind: kindId } : {}),
            })
            await client.updateInstance.mutate({
              addonId,
              id: created.id,
              values: item.values,
            })
            lastId = created.id
          } catch (err) {
            // The ones already created stay; say how far it got and why it stopped.
            void queryClient.invalidateQueries({
              queryKey: [HOLDER_QUERY_KEY],
            })
            throw new Error(
              t(
                'providerInstances.createManyStopped',
                '{{done}} of {{total}} created: {{message}}',
                {
                  done: index,
                  total: items.length,
                  message: err instanceof Error ? err.message : String(err),
                },
              ),
            )
          }
        }
        return lastId
      }
      if (instance === null) {
        // The old id wins; else the provider mints one when it can; else the UI mints an opaque id.
        const chosen =
          canRestore && restoring
            ? restoreId
            : idRule !== undefined
              ? typed
              : uiProposesInstanceId(description, kind)
                ? mintInstanceId(description.instanceMode, addonId, randomHex8)
                : undefined
        const created = await client.createInstance.mutate({
          addonId,
          name,
          ...(chosen !== undefined ? { id: chosen } : {}),
          ...(kindId !== '' ? { kind: kindId } : {}),
        })
        if (Object.keys(patch).length > 0) {
          await client.updateInstance.mutate({
            addonId,
            id: created.id,
            values: patch,
          })
        }
        return created.id
      }
      await client.updateInstance.mutate({
        addonId,
        id: instance.id,
        name,
        values: patch,
      })
      return instance.id
    },
    onSuccess: (savedId) => {
      void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      pushToast({
        title: t('providerInstances.saved', 'Saved'),
        message: many ? String(picked.length) : name,
        severity: 'info',
      })
      onSaved?.(savedId)
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const test = useMutation({
    mutationFn: () =>
      system.trpcClient.integrationInstances.testInstance.mutate({
        addonId,
        id: instanceId,
        values: diffInstanceValues(stored, edited),
        // A draft of a provider with several kinds names the kind being created.
        ...(instanceId === null && kind !== undefined ? { kind: kind.id } : {}),
      }),
    onSuccess: (result) => setVerdict(toTestVerdict(result)),
    // A transport failure of the CALL is not a verdict on the credentials.
    onError: (err: Error) => setVerdict({ status: 'inconclusive', error: err.message }),
  })

  const title =
    instance === null
      ? t('providerInstances.createTitle', 'Add {{provider}}', {
          provider: createLabel(description, kind, providerName),
        })
      : t('providerInstances.editTitle', 'Edit {{name}}', {
          name: instance.name,
        })

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      title={title}
      error={error ?? (schemaQuery.isError ? schemaQuery.error.message : null)}
      width="lg"
      footer={
        <>
          {description.canTest && (
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={test.isPending || (hydrated === null && !noForm)}
              onClick={() => {
                setVerdict(null)
                test.mutate()
              }}
            >
              {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('providerInstances.test', 'Test connection')}
            </Button>
          )}
          <Button
            size="sm"
            type="button"
            disabled={
              save.isPending ||
              (hydrated === null && !noForm) ||
              (name.length === 0 && !many) ||
              (!many && (restoreMissing || typedState !== 'ok'))
            }
            onClick={() => {
              setError(null)
              save.mutate()
            }}
          >
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {instance === null && many
              ? t('providerInstances.createMany', 'Create {{count}}', {
                  count: picked.length,
                })
              : instance === null
                ? t('providerInstances.create', 'Create')
                : t('providerInstances.saveChanges', 'Save changes')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {instance !== null ? lead : null}
        <FormBuilder
          schema={
            many
              ? withoutFields(identitySchema, [
                  IDENTITY_NAME,
                  IDENTITY_TYPED_ID,
                  IDENTITY_RESTORE,
                  IDENTITY_RESTORE_ID,
                ])
              : identitySchema
          }
          values={identity}
          onChange={setIdentity}
        />
        {manyField !== null && many && (
          <ManyPickLabels field={manyField} values={values} onLabels={onPickLabels} />
        )}
        {kind?.signIn !== undefined && (
          <BrokerSignInPanel
            basePath={kind.signIn.basePath}
            {...(kind.signIn.methods !== undefined ? { methods: kind.signIn.methods } : {})}
            name={name}
            {...(instance !== null ? { brokerId: instance.id } : {})}
            getSettings={() => effectiveInstanceValues(stored, edited)}
            disabled={name.length === 0}
            onSignedIn={(signedInId) => {
              void queryClient.invalidateQueries({
                queryKey: [HOLDER_QUERY_KEY],
              })
              onSaved?.(signedInId)
              onClose()
            }}
          />
        )}
        {instance !== null && kind?.connectPath !== undefined && (
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() =>
              startServerNavigation(
                fillBrokerConnectPath(kind.connectPath ?? '', instance.id),
                () =>
                  void queryClient.invalidateQueries({
                    queryKey: [HOLDER_QUERY_KEY],
                  }),
              )
            }
          >
            <Link2 className="h-3.5 w-3.5" />
            {t('providerInstances.connect', 'Connect account')}
          </Button>
        )}
        {hydrated === null ? (
          schemaQuery.isError ? null : noForm ? (
            <p className="text-xs text-foreground-muted">
              {t(
                'providerInstances.noForm',
                'This record has no configuration form beyond its name.',
              )}
            </p>
          ) : (
            <div className="flex items-center gap-2 text-xs text-foreground-subtle">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('providerInstances.loading', 'Loading…')}
            </div>
          )
        ) : (
          <>
            <ConfigFormBuilder
              schema={withoutFields(hydrated, widgetOwnedKeys)}
              values={values}
              onChange={setValues}
            />
            {connectionWidgets.map(({ id, widget: { Component } }) => (
              <Component key={id} schema={hydrated} values={values} onValuesChange={setValues} />
            ))}
          </>
        )}
        {verdict !== null && <TestVerdictBanner verdict={verdict} />}
      </div>
    </ItemFormDialog>
  )
}
