import { useUiText, UiTrans } from '../contexts/ui-text'
import { MODEL_PROVIDER_IDS, type ModelProviderId, type PipelineAddonSchema } from '@camstack/types'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { cn } from '../lib/cn'
import { GroupedModelSelector } from './grouped-model-selector'

export type ModelOption = PipelineAddonSchema['models'][number]

const PROVIDER_LABEL: Readonly<Record<ModelProviderId, string>> = {
  camstack: 'CamStack',
  frigate: 'plus catalog',
  scrypted: 'plugin catalog',
  custom: 'Custom',
}

function providerOf(model: ModelOption): ModelProviderId {
  return model.provider ?? 'camstack'
}

/**
 * Shared model picker — the ONE model-selection control across the app.
 *
 * Provider first (CamStack / plus catalog / plugin catalog / Custom), then inside that
 * catalog the grouped Family→Tier→Variant selector when entries declare
 * `group`, else a flat `<select>`. The persisted value stays the flat model
 * id. `value === ''` renders nothing selected (callers that support an
 * "Auto / node default" mode own that affordance and hide this picker while
 * it is active).
 */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  defaultModelId,
}: {
  readonly models: readonly ModelOption[]
  readonly value: string
  readonly onChange: (id: string) => void
  readonly disabled?: boolean
  /** Catalog / format default — offered when the current pin is no longer listed. */
  readonly defaultModelId?: string
}): JSX.Element {
  const t = useUiText()
  const byProvider = useMemo(() => {
    const map = new Map<ModelProviderId, ModelOption[]>()
    for (const m of models) {
      const provider = providerOf(m)
      const list = map.get(provider)
      if (list) list.push(m)
      else map.set(provider, [m])
    }
    return map
  }, [models])

  const presentProviders = useMemo(
    () => MODEL_PROVIDER_IDS.filter((id) => (byProvider.get(id)?.length ?? 0) > 0),
    [byProvider],
  )

  const pinnedProvider = useMemo(() => {
    const pinned = models.find((m) => m.id === value)
    return pinned ? providerOf(pinned) : undefined
  }, [models, value])

  const defaultProvider: ModelProviderId =
    pinnedProvider ??
    (presentProviders.includes('camstack') ? 'camstack' : (presentProviders[0] ?? 'camstack'))

  const [provider, setProvider] = useState<ModelProviderId>(defaultProvider)
  useEffect(() => {
    setProvider(defaultProvider)
  }, [defaultProvider])

  const valueUnresolvable = value !== '' && !models.some((m) => m.id === value)
  const fallbackId =
    defaultModelId !== undefined && models.some((m) => m.id === defaultModelId)
      ? defaultModelId
      : models[0]?.id

  const unresolvedBanner = valueUnresolvable && (
    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-300 space-y-1.5">
      {/* D725: a pin to a model DELETED from the catalog is reset to the default
          by the hub on its own (orchestrator stored-pin reset), so it never
          reaches here once the hub has swept. What still can: an id this
          format is not offered — a custom model that is not installed, or a
          model with no build for this accelerator. The button edits the
          draft only; nothing is stored until Save. */}
      <p>
        <UiTrans
          uiKey="uiLibrary.modelPicker.unresolved"
          fallback="Current pin (<0>{{value}}</0>) is not offered for this device. The runtime tries it as a custom model and refuses it if it cannot serve it. Pick a replacement and Save."
          components={[<span key="v" className="font-mono" />]}
          values={{ value }}
        />
      </p>
      {fallbackId !== undefined && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(fallbackId)}
          className="rounded border border-amber-500/50 px-2 py-0.5 text-[10px] font-medium hover:bg-amber-500/20 disabled:opacity-50"
        >
          <UiTrans
            uiKey="uiLibrary.modelPicker.useDefault"
            fallback="Use default (<0>{{id}}</0>) — then Save"
            components={[<span key="d" className="font-mono" />]}
            values={{ id: fallbackId }}
          />
        </button>
      )}
    </div>
  )

  const scoped = byProvider.get(provider) ?? []
  const grouped = scoped.filter((m) => m.group !== undefined)
  const ungrouped = scoped.filter((m) => m.group === undefined)

  const flatSelect = (opts: readonly ModelOption[], selectPlaceholder?: string) => (
    <select
      disabled={disabled}
      className="w-full bg-surface border border-border rounded px-2 py-1 text-xs disabled:opacity-50"
      value={opts.some((m) => m.id === value) ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {selectPlaceholder !== undefined && (
        <option value="" disabled>
          {selectPlaceholder}
        </option>
      )}
      {opts.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  )

  return (
    <div className="space-y-3">
      {unresolvedBanner}
      {presentProviders.length > 1 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5">
            {t('uiLibrary.modelPicker.provider', 'Provider')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {presentProviders.map((id) => (
              <button
                key={id}
                type="button"
                disabled={disabled}
                onClick={() => setProvider(id)}
                className={cn(
                  'rounded-full px-3 py-1 text-[11px] font-medium border transition-colors',
                  id === provider
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-foreground-subtle hover:text-foreground hover:border-foreground-subtle/40',
                  disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                )}
              >
                {PROVIDER_LABEL[id]}
              </button>
            ))}
          </div>
        </div>
      )}
      {grouped.length > 0 && (
        <GroupedModelSelector
          catalog={grouped}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {ungrouped.length > 0 &&
        flatSelect(ungrouped, grouped.length > 0 ? '— other models —' : '— select a model —')}
      {/* A format with no build at all rendered the "Model" heading and then
          NOTHING — indistinguishable from a list still loading, or from a
          broken panel. Absent must never look like unknown (D315). Saying it
          plainly also names the action: this is a fact about the FORMAT, not
          about the operator's choice, so there is no control to offer. */}
      {models.length === 0 && (
        <p className="text-[11px] text-foreground-subtle">
          {t('uiLibrary.modelPicker.none', 'No model is published for this engine format.')}
        </p>
      )}
    </div>
  )
}
