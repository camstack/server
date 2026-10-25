/**
 * Waste Collections Settings — DataTable + Country → Service via ConfigFormBuilder.
 */
import type { ConfigUISchema } from '@camstack/types'
import {
  Badge,
  Button,
  ConfigFormBuilder,
  DataTable,
  ItemFormDialog,
  Skeleton,
  useConfirm,
  useItemFormUrl,
  useSystem,
  type DataColumn,
} from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Recycle, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { NodeAddonsSettingsPanel } from '../../components/settings/NodeAddonsSettingsPanel'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const SOURCES_KEY = ['wasteCollections', 'listSources'] as const
const COUNTRIES_KEY = ['wasteCollections', 'listCountries'] as const

interface WasteSourceRow {
  readonly id: string
  readonly label: string
  readonly module: string
  readonly enabled: boolean
  readonly formValues?: Record<string, unknown>
  readonly serviceId?: string
  readonly countryId?: string
}

interface CountryRow {
  readonly id: string
  readonly label: string
}

interface ServiceRow {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly module: string
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isConfigSchema(value: unknown): value is ConfigUISchema {
  if (typeof value !== 'object' || value === null) return false
  return Array.isArray(Reflect.get(value, 'sections'))
}

function parseSourceRows(raw: unknown): readonly WasteSourceRow[] {
  if (!Array.isArray(raw)) return []
  const out: WasteSourceRow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const id = Reflect.get(item, 'id')
    const label = Reflect.get(item, 'label')
    const module = Reflect.get(item, 'module')
    if (typeof id !== 'string' || typeof label !== 'string' || typeof module !== 'string') continue
    const enabled = Reflect.get(item, 'enabled')
    const formValues = Reflect.get(item, 'formValues')
    const serviceId = Reflect.get(item, 'serviceId')
    const countryId = Reflect.get(item, 'countryId')
    out.push({
      id,
      label,
      module,
      enabled: typeof enabled === 'boolean' ? enabled : true,
      formValues:
        typeof formValues === 'object' && formValues !== null && !Array.isArray(formValues)
          ? (formValues as Record<string, unknown>)
          : undefined,
      serviceId: typeof serviceId === 'string' ? serviceId : undefined,
      countryId: typeof countryId === 'string' ? countryId : undefined,
    })
  }
  return out
}

function parseCountries(raw: unknown): readonly CountryRow[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const id = Reflect.get(item, 'id')
    const label = Reflect.get(item, 'label')
    if (typeof id !== 'string' || typeof label !== 'string') return []
    return [{ id, label }]
  })
}

function parseServices(raw: unknown): readonly ServiceRow[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const id = Reflect.get(item, 'id')
    const label = Reflect.get(item, 'label')
    const module = Reflect.get(item, 'module')
    if (typeof id !== 'string' || typeof label !== 'string' || typeof module !== 'string') return []
    const titleRaw = Reflect.get(item, 'title')
    const title = typeof titleRaw === 'string' && titleRaw.length > 0 ? titleRaw : label
    return [{ id, label, title, module }]
  })
}

function buildPickerSchema(
  countries: readonly CountryRow[],
  services: readonly ServiceRow[],
  countryId: string,
): ConfigUISchema {
  return {
    sections: [
      {
        id: 'picker',
        title: i18n.t('system.wasteSettingsSources.countryService', 'Country & service'),
        columns: 2,
        fields: [
          {
            type: 'select',
            key: 'countryId',
            label: i18n.t('system.wasteSettingsSources.country', 'Country'),
            options: [
              {
                value: '',
                label: i18n.t('system.wasteSettingsSources.selectCountry', 'Select country…'),
              },
              ...countries.map((c) => ({ value: c.id, label: c.label })),
            ],
          },
          {
            type: 'select',
            key: 'serviceId',
            label: i18n.t('system.wasteSettingsSources.service', 'Service'),
            options: [
              {
                value: '',
                label:
                  countryId === ''
                    ? i18n.t(
                        'system.wasteSettingsSources.pickACountryFirst',
                        'Pick a country first',
                      )
                    : i18n.t('system.wasteSettingsSources.selectService', 'Select service…'),
              },
              ...services.map((s) => ({ value: s.id, label: s.label })),
            ],
          },
        ],
      },
    ],
  }
}

export interface WasteSettingsSourcesProps {
  readonly addonId: string
  readonly capName: string
}

export function WasteSettingsSources({ addonId, capName }: WasteSettingsSourcesProps): JSX.Element {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const formUrl = useItemFormUrl({ editKey: 'wasteEdit', newKey: 'wasteNew' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [pickerValues, setPickerValues] = useState<Record<string, unknown>>({
    countryId: '',
    serviceId: '',
  })
  const [formValues, setFormValues] = useState<Record<string, unknown>>({
    label: t('system.wasteSettingsSources.newSource', 'New source'),
    enabled: true,
  })
  const seededKey = useRef<string | null>(null)

  const countryId = typeof pickerValues['countryId'] === 'string' ? pickerValues['countryId'] : ''
  const serviceId = typeof pickerValues['serviceId'] === 'string' ? pickerValues['serviceId'] : ''

  const custom = useCallback(
    (action: string, input: Record<string, unknown>) =>
      system.trpcClient.addons.custom.mutate({ addonId, action, input }),
    [addonId, system],
  )

  const listQuery = useQuery({
    queryKey: [...SOURCES_KEY, addonId],
    queryFn: async () => parseSourceRows(await custom('listSources', {})),
  })
  const countriesQuery = useQuery({
    queryKey: [...COUNTRIES_KEY, addonId],
    queryFn: async () => parseCountries(await custom('listCountries', {})),
  })
  const servicesQuery = useQuery({
    queryKey: ['wasteCollections', 'listServices', addonId, countryId],
    enabled: countryId !== '',
    queryFn: async () => parseServices(await custom('listServices', { countryId })),
  })
  const schemaQuery = useQuery({
    queryKey: ['wasteCollections', 'serviceFormSchema', addonId, serviceId],
    enabled: serviceId !== '',
    queryFn: async () => custom('serviceFormSchema', { serviceId }),
  })

  const rows = listQuery.data ?? []
  const countries = countriesQuery.data ?? []
  const services = servicesQuery.data ?? []
  const configSchema = isConfigSchema(schemaQuery.data) ? schemaQuery.data : undefined
  const pickerSchema = useMemo(
    () => buildPickerSchema(countries, countryId === '' ? [] : services, countryId),
    [countries, services, countryId],
  )

  const formState = formUrl.state
  const editing =
    formState.mode === 'edit' ? (rows.find((r) => r.id === formState.id) ?? null) : null

  useEffect(() => {
    if (formUrl.state.mode === 'edit' && editing !== null) {
      const key = `edit:${editing.id}`
      if (seededKey.current === key) return
      seededKey.current = key
      setFormError(null)
      setPickerValues({
        countryId: editing.countryId ?? '',
        serviceId: editing.serviceId ?? '',
      })
      setFormValues(
        editing.formValues !== undefined
          ? { ...editing.formValues }
          : { label: editing.label, enabled: editing.enabled },
      )
      return
    }
    if (formUrl.state.mode === 'new') {
      if (seededKey.current === 'new') return
      seededKey.current = 'new'
      setFormError(null)
      setPickerValues({ countryId: '', serviceId: '' })
      setFormValues({
        label: t('system.wasteSettingsSources.newSource', 'New source'),
        enabled: true,
      })
    }
  }, [editing, formUrl.state])

  useEffect(() => {
    if (formUrl.state.mode !== 'new' || serviceId === '') return
    const svc = services.find((s) => s.id === serviceId)
    if (!svc) return
    setFormValues((prev) => {
      const label = prev['label']
      if (typeof label === 'string' && label !== '' && label !== 'New source') return prev
      return { ...prev, label: svc.title }
    })
  }, [formUrl.state.mode, serviceId, services])

  const onPickerChange = useCallback((next: Record<string, unknown>) => {
    setPickerValues((prev) => {
      const nextCountry = typeof next['countryId'] === 'string' ? next['countryId'] : ''
      const prevCountry = typeof prev['countryId'] === 'string' ? prev['countryId'] : ''
      if (nextCountry !== prevCountry) {
        return { countryId: nextCountry, serviceId: '' }
      }
      return next
    })
  }, [])

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: SOURCES_KEY })
  }, [queryClient])

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => custom('deleteSource', { id }),
    onSuccess: async () => invalidate(),
  })

  const onDelete = useCallback(
    async (row: WasteSourceRow) => {
      const ok = await confirm({
        title: t('system.wasteSettingsSources.deleteWasteSource', 'Delete waste source?'),
        message: t(
          'system.wasteSettingsSources.removeItsCalendarUnderSystem',
          'Remove “{{label}}” ({{id}}). Its calendar under System → Calendars is dropped.',
          { label: row.label, id: row.id },
        ),
        confirmLabel: t('common.delete', 'Delete'),
        cancelLabel: t('common.cancel', 'Cancel'),
        variant: 'danger',
      })
      if (!ok) return
      await deleteMutation.mutateAsync(row.id)
      if (formUrl.state.mode === 'edit' && formUrl.state.id === row.id) {
        formUrl.close()
        seededKey.current = null
      }
    },
    [confirm, deleteMutation, formUrl, t],
  )

  const onSave = useCallback(async () => {
    const labelRaw = formValues['label']
    const label = typeof labelRaw === 'string' && labelRaw.trim() !== '' ? labelRaw.trim() : ''
    if (label === '') {
      setFormError('Label is required.')
      return
    }
    if (serviceId === '') {
      setFormError('Pick a country and a service.')
      return
    }

    const isNew = formUrl.state.mode === 'new'
    const editingId = editing?.id
    if (!isNew && (editingId === undefined || editingId === '')) {
      setFormError('That source is no longer available.')
      return
    }

    const enabledRaw = formValues['enabled']
    const args: Record<string, unknown> = { ...formValues }
    delete args['label']
    delete args['enabled']

    setSubmitting(true)
    setFormError(null)
    try {
      if (isNew) {
        await custom('createSource', {
          label,
          serviceId,
          args,
          enabled: typeof enabledRaw === 'boolean' ? enabledRaw : true,
        })
      } else if (editingId !== undefined) {
        await custom('updateSource', {
          id: editingId,
          label,
          serviceId,
          args,
          enabled: typeof enabledRaw === 'boolean' ? enabledRaw : true,
        })
      }
      await invalidate()
      formUrl.close()
      seededKey.current = null
    } catch (err: unknown) {
      setFormError(errorText(err))
    } finally {
      setSubmitting(false)
    }
  }, [custom, editing, formUrl, formValues, invalidate, serviceId])

  const columns: DataColumn<WasteSourceRow>[] = useMemo(
    () => [
      {
        key: 'label',
        header: t('system.wasteSettingsSources.label', 'Label'),
        sortValue: (row) => row.label,
        render: (row) => <span className="text-sm text-foreground">{row.label}</span>,
      },
      {
        key: 'module',
        header: t('system.wasteSettingsSources.module', 'Module'),
        sortValue: (row) => row.module,
        render: (row) => (
          <span className="font-mono text-xs text-foreground-muted">{row.module}</span>
        ),
      },
      {
        key: 'enabled',
        header: t('system.wasteSettingsSources.enabled', 'Enabled'),
        sortValue: (row) => (row.enabled ? 1 : 0),
        render: (row) => (
          <Badge variant={row.enabled ? 'success' : 'default'}>
            {row.enabled
              ? t('system.wasteSettingsSources.on', 'On')
              : t('system.wasteSettingsSources.off', 'Off')}
          </Badge>
        ),
      },
      {
        key: 'actions',
        header: '',
        notSortableReason: 'actions',
        render: (row) => (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t('system.wasteSettingsSources.delete', 'Delete {{label}}', {
              label: row.label,
            })}
            data-testid={`waste-source-delete-${row.id}`}
            onClick={(e) => {
              e.stopPropagation()
              void onDelete(row)
            }}
          >
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
        ),
      },
    ],
    [onDelete, t],
  )

  const isNew = formUrl.state.mode === 'new'
  const dialogOpen = isNew || editing !== null
  const builderKey = `${serviceId}:${isNew ? 'new' : (editing?.id ?? 'closed')}`

  return (
    <div className="flex min-h-0 flex-col gap-4" data-testid="waste-settings-sources">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-muted">
          {t(
            'system.wasteSettingsSources.pickACountryAndA',
            'Pick a country and a service — configuration fields come from that HACS source.',
          )}
        </p>
        <Button
          type="button"
          size="sm"
          data-testid="waste-sources-add"
          onClick={() => formUrl.openNew()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('system.wasteSettingsSources.addSource', 'Add source')}
        </Button>
      </div>

      {listQuery.isError ? (
        <p className="text-sm text-danger">
          {t('system.wasteSettingsSources.couldNotLoadSources', 'Could not load sources.')}
        </p>
      ) : null}

      {listQuery.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={25}
          emptyMessage={t(
            'system.wasteSettingsSources.noWasteSourcesYetAdd',
            'No waste sources yet. Add one to register a municipal service.',
          )}
          onRowClick={(row) => formUrl.openEdit(row.id)}
          defaultSort={{ columnKey: 'label', dir: 'asc' }}
        />
      )}

      <ItemFormDialog
        open={dialogOpen}
        onClose={() => {
          formUrl.close()
          setFormError(null)
          seededKey.current = null
        }}
        title={
          isNew
            ? t('system.wasteSettingsSources.addWasteSource', 'Add waste source')
            : t('system.wasteSettingsSources.edit', 'Edit {{value1}}', {
                value1: editing?.label ?? 'source',
              })
        }
        icon={Recycle}
        width="xl"
        testId="waste-source-editor"
        error={formError}
        footer={
          <Button
            type="button"
            size="sm"
            disabled={submitting || serviceId === ''}
            onClick={() => void onSave()}
          >
            {submitting
              ? t('system.wasteSettingsSources.saving', 'Saving…')
              : t('common.save', 'Save')}
          </Button>
        }
      >
        {dialogOpen ? (
          <>
            <div data-testid="waste-country-service">
              <ConfigFormBuilder
                key={`picker:${countryId}:${services.length}`}
                schema={pickerSchema}
                values={pickerValues}
                onChange={onPickerChange}
              />
            </div>

            {serviceId !== '' && configSchema !== undefined ? (
              <ConfigFormBuilder
                key={builderKey}
                schema={configSchema}
                values={formValues}
                onChange={setFormValues}
                bare
              />
            ) : serviceId !== '' && schemaQuery.isPending ? (
              <p className="text-sm text-foreground-muted">
                {t('system.wasteSettingsSources.loadingFields', 'Loading fields…')}
              </p>
            ) : (
              <p className="text-sm text-foreground-muted">
                {t(
                  'system.wasteSettingsSources.chooseACountryAndService',
                  'Choose a country and service to see the required fields.',
                )}
              </p>
            )}
          </>
        ) : null}
      </ItemFormDialog>

      <NodeAddonsSettingsPanel
        nodeId="hub"
        addonIds={[addonId]}
        level="global"
        capability={capName}
        hideSectionChrome
      />
    </div>
  )
}
