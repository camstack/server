/**
 * The top of an AI profile's edit dialog: the parts of a profile the generic form cannot draw.
 *
 * - A kind that names provider widgets (`ai/managed-model`, `ai/apple-node`) gets them, looked up
 *   by their generic id in `ai-provider-widgets`; nothing here branches on a kind.
 * - A kind without a model widget gets the model picker: "Load models" asks `llm.listModels` for
 *   the stored record's connection and the choice is written to the record.
 *
 * Both write through `integrationInstances.updateInstance` at once (a batched patch per change),
 * so the dialog's own "Save changes" only carries what the operator typed in the form below.
 */
import type { LlmModelInfo } from '@camstack/types'
import {
  Button,
  CAP_INSTANCES_QUERY_KEY,
  ErrorBox,
  FormField,
  Select,
  useSystem,
} from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { HOLDER_QUERY_KEY } from '../../components/instances/use-instances-data'
import type { InstanceRow } from '../../components/instances/instances-model'
import { type ModelSelection, providerWidget } from './ai-provider-widgets'

type Values = Record<string, unknown>

function textOf(values: Values, key: string): string {
  const v = values[key]
  return typeof v === 'string' ? v : ''
}

export function AiProfileLead({ row }: { readonly row: InstanceRow }): ReactElement | null {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const leadKey = useMemo(() => [HOLDER_QUERY_KEY, row.addonId, 'ai-lead', row.id], [row])

  const loaded = useQuery({
    queryKey: leadKey,
    queryFn: async () => {
      const client = system.trpcClient.integrationInstances
      const [description, instance] = await Promise.all([
        client.describe.query({ addonId: row.addonId }),
        client.getInstance.query({ addonId: row.addonId, id: row.id }),
      ])
      return { description, instance }
    },
  })

  // What this lead has written and the record has not echoed back yet.
  const [overlay, setOverlay] = useState<Values>({})
  const pending = useRef<Values>({})
  const scheduled = useRef(false)

  const write = useMutation({
    mutationFn: (values: Values) =>
      system.trpcClient.integrationInstances.updateInstance.mutate({
        addonId: row.addonId,
        id: row.id,
        values,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      await queryClient.invalidateQueries({ queryKey: [CAP_INSTANCES_QUERY_KEY] })
      setOverlay({})
    },
  })

  /** Changes made in the same tick (a widget replaces config and model together) go as ONE patch. */
  const patch = useCallback(
    (values: Values): void => {
      pending.current = { ...pending.current, ...values }
      setOverlay((current) => ({ ...current, ...values }))
      if (scheduled.current) return
      scheduled.current = true
      queueMicrotask(() => {
        const batch = pending.current
        pending.current = {}
        scheduled.current = false
        write.mutate(batch)
      })
    },
    [write],
  )

  const kind = loaded.data?.description.kinds?.find((k) => k.id === row.kindId)
  const stored = loaded.data?.instance?.formValues
  const values = useMemo<Values>(() => ({ ...stored, ...overlay }), [stored, overlay])
  const widgets = kind?.widgets ?? []
  const modelWidget = widgets.some((w) => w.placement === 'model')

  const providerConfig = useMemo<Values>(
    () => ({
      ...(textOf(values, 'nodeId') !== '' ? { nodeId: textOf(values, 'nodeId') } : {}),
      ...(typeof values.modelRef === 'object' && values.modelRef !== null
        ? { model: values.modelRef }
        : {}),
    }),
    [values],
  )
  const model: ModelSelection = {
    id: textOf(values, 'model'),
    supportsVision: values.supportsVision === true,
  }

  const listing = useMutation({
    mutationFn: () =>
      system.trpcClient.llm.listModels.mutate({
        addonId: row.addonId,
        kind: row.kindId ?? '',
        profileId: row.id,
      }),
  })

  if (loaded.isPending) return null
  if (loaded.isError) {
    return <ErrorBox variant="warning" message={loaded.error.message} />
  }

  const listed: readonly LlmModelInfo[] = listing.data?.ok === true ? listing.data.models : []
  const refused = listing.data?.ok === false ? listing.data : null
  const pickModel = (id: string): void => {
    const info = listed.find((m) => m.id === id)
    patch({
      model: id,
      ...(info?.features?.vision !== undefined ? { supportsVision: info.features.vision } : {}),
    })
  }

  return (
    <div className="space-y-3" data-testid="ai-profile-lead">
      {widgets.map(({ id }) => {
        const Widget = providerWidget(id)
        if (Widget === null) {
          return (
            <ErrorBox
              key={id}
              variant="warning"
              message={t(
                'ai.unknownWidget',
                'This provider needs an editor part this build does not have ({{id}}).',
                { id },
              )}
            />
          )
        }
        return (
          <Widget
            key={id}
            providerConfig={providerConfig}
            onProviderConfigChange={(next) =>
              patch({
                ...(textOf(next, 'nodeId') !== textOf(providerConfig, 'nodeId')
                  ? { nodeId: textOf(next, 'nodeId') }
                  : {}),
                ...(next.model !== undefined && next.model !== providerConfig.model
                  ? { modelRef: next.model }
                  : {}),
              })
            }
            model={model}
            onModelChange={(next) => patch({ model: next.id, supportsVision: next.supportsVision })}
          />
        )
      })}
      {!modelWidget && (
        <FormField label={t('ai.model', 'Model')}>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              type="button"
              disabled={listing.isPending}
              onClick={() => listing.mutate()}
            >
              {listing.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('ai.loadModels', 'Load models')}
            </Button>
            {listed.length > 0 && (
              <Select
                aria-label={t('ai.model', 'Model')}
                value={model.id}
                onChange={(e) => pickModel(e.target.value)}
                options={[
                  ...(listed.some((m) => m.id === model.id) || model.id === ''
                    ? []
                    : [{ value: model.id, label: model.id }]),
                  ...listed.map((m) => ({ value: m.id, label: m.label ?? m.id })),
                ]}
              />
            )}
          </div>
          {refused !== null && <p className="mt-1 text-xs text-danger">{refused.message}</p>}
          {listing.isError && <p className="mt-1 text-xs text-danger">{listing.error.message}</p>}
        </FormField>
      )}
      {write.isError && <ErrorBox variant="warning" message={write.error.message} />}
    </div>
  )
}
