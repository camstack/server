/**
 * The AI page's create/edit surface (D893): the kind pre-modal, then the
 * profile editor, both in library `ItemFormDialog` (managed-list contract).
 *
 * The editor is drawn from the kind's descriptor and nothing else — it has no
 * branch on a kind id, so a kind a third-party provider declares renders with
 * no change here:
 *
 *   ① provider header — the chosen kind; changed only back through the pre-modal
 *   ② Connection — the provider's `connectionSchema` (+ its connection widgets),
 *      with "Verify & load models" calling `llm.listModels` on the DRAFT
 *   ③ Model — the list `listModels` answered (or the kind's static list), always
 *      a free model id, feature badges; a `model` widget replaces all of it
 *   ④ Generation — the common sampling fields the kind offers
 *   ▸ Advanced — bounds/policy the kind offers + the provider's `advancedSchema`
 */
import type {
  ConfigUISchema,
  LlmListModelsResult,
  LlmProfile,
  LlmProfileKindDescriptor,
} from '@camstack/types'
import { collectSecretConfigKeys } from '@camstack/types'
import {
  Badge,
  Button,
  CollapsibleCard,
  ConfigFormBuilder,
  ErrorBox,
  FormField,
  GroupedTilePicker,
  Input,
  ItemFormDialog,
  SECTION_BODY,
  SectionCard,
  Select,
  STACK_GAP,
  Switch,
  useSystem,
} from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { groupKindsByAddon, iconForName, REDACTED_MARKER } from './ai-page.helpers'
import {
  advancedCommonSchema,
  commonValuesOf,
  draftToProfile,
  effectiveFeatures,
  generationSchema,
  modelChoices,
} from './ai-profile-form'
import { type ModelSelection, providerWidget } from './ai-provider-widgets'

interface KindGlyphProps {
  readonly kind: Pick<LlmProfileKindDescriptor, 'icon'>
  readonly className: string
}

/** The descriptor's icon NAME, drawn — see the icon rule in `ai-page.helpers.ts`. */
export function KindGlyph({ kind, className }: KindGlyphProps) {
  const Icon = iconForName(kind.icon)
  return <Icon className={className} aria-hidden />
}

interface KindPickerDialogProps {
  readonly kinds: readonly LlmProfileKindDescriptor[]
  readonly onPick: (kind: LlmProfileKindDescriptor) => void
  readonly onCancel: () => void
}

export function KindPickerDialog({ kinds, onPick, onCancel }: KindPickerDialogProps) {
  const { t } = useTranslation()
  const groups = useMemo(() => groupKindsByAddon(kinds), [kinds])
  const byKey = useMemo(
    () =>
      new Map<string, LlmProfileKindDescriptor>(kinds.map((k) => [`${k.addonId}:${k.kind}`, k])),
    [kinds],
  )
  return (
    <ItemFormDialog
      open
      onClose={onCancel}
      title={t('ai.chooseKind', 'Choose a profile type')}
      width="lg"
      testId="ai-kind-picker"
    >
      <GroupedTilePicker
        emptyMessage={t('ai.noKinds', 'No AI provider is installed.')}
        onPick={(key) => {
          const kind = byKey.get(key)
          if (kind !== undefined) onPick(kind)
        }}
        groups={groups.map((group) => ({
          id: group.addonId,
          label: group.addonId,
          tiles: group.kinds.map((kind) => ({
            key: `${group.addonId}:${kind.kind}`,
            label: kind.label,
            testId: `ai-kind-${kind.kind}`,
            icon: <KindGlyph kind={kind} className="h-5 w-5 text-foreground-subtle" />,
          })),
        }))}
      />
    </ItemFormDialog>
  )
}

// ── schema helpers (generic) ──────────────────────────────────────────

function fieldsOfSchema(
  schema: ConfigUISchema | undefined,
): ConfigUISchema['sections'][number]['fields'] {
  return (schema?.sections ?? []).flatMap((s) => s.fields)
}

/** A new profile starts from the defaults its provider's schemas declare. */
function schemaDefaults(
  ...schemas: readonly (ConfigUISchema | undefined)[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const schema of schemas) {
    for (const field of fieldsOfSchema(schema)) {
      if ('default' in field && field.default !== undefined) out[field.key] = field.default
    }
  }
  return out
}

function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

/** The required connection fields still empty (a stored secret counts as set). */
function missingRequired(schema: ConfigUISchema, values: Record<string, unknown>): string[] {
  return fieldsOfSchema(schema)
    .filter((f) => 'required' in f && f.required === true && !isFilled(values[f.key]))
    .map((f) => ('label' in f && typeof f.label === 'string' ? f.label : f.key))
}

// ── the editor ────────────────────────────────────────────────────────

interface ProfileEditorDialogProps {
  readonly kind: LlmProfileKindDescriptor
  readonly existing: LlmProfile | null
  readonly onSave: (profile: LlmProfile) => void
  readonly onCancel: () => void
  /** New profiles only: back to the pre-modal to pick another kind. */
  readonly onChangeKind?: () => void
  readonly saving: boolean
  readonly error: string | null
}

const LIST_ERROR_TITLE: Readonly<Record<string, { key: string; fallback: string }>> = {
  auth: { key: 'ai.listAuth', fallback: 'Credentials refused' },
  network: { key: 'ai.listNetwork', fallback: 'Endpoint unreachable' },
  unsupported: { key: 'ai.listUnsupported', fallback: 'No model list' },
  invalid: { key: 'ai.listInvalid', fallback: 'Connection incomplete' },
}

function initialModel(kind: LlmProfileKindDescriptor, existing: LlmProfile | null): ModelSelection {
  if (existing !== null) return { id: existing.model, supportsVision: existing.supportsVision }
  const only = kind.modelCatalog === 'static' && kind.staticModels?.length === 1
  const first = only ? kind.staticModels?.[0] : undefined
  return {
    id: first?.id ?? '',
    supportsVision: effectiveFeatures(kind, first).vision,
  }
}

export function ProfileEditorDialog({
  kind,
  existing,
  onSave,
  onCancel,
  onChangeKind,
  saving,
  error,
}: ProfileEditorDialogProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const [name, setName] = useState(existing?.name ?? kind.label)
  const [providerConfig, setProviderConfig] = useState<Record<string, unknown>>(() =>
    existing !== null
      ? { ...existing.providerConfig }
      : schemaDefaults(kind.connectionSchema, kind.advancedSchema),
  )
  const [common, setCommon] = useState<Record<string, unknown>>(() => commonValuesOf(existing))
  const [model, setModel] = useState<ModelSelection>(() => initialModel(kind, existing))
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const widgets = kind.providerWidgets ?? []
  const connectionWidgets = widgets.filter((w) => w.placement === 'connection')
  const modelWidget = widgets.find((w) => w.placement === 'model') ?? null
  const hasStoredSecret = useMemo(
    () =>
      [...collectSecretConfigKeys(kind.connectionSchema)].some(
        (key) => existing?.providerConfig[key] === REDACTED_MARKER,
      ),
    [existing, kind.connectionSchema],
  )

  const listing = useMutation({
    mutationFn: (): Promise<LlmListModelsResult> =>
      system.trpcClient.llm.listModels.mutate({
        addonId: kind.addonId,
        kind: kind.kind,
        connection: providerConfig,
        ...(existing !== null ? { profileId: existing.id } : {}),
      }),
    // The list carries each model's own features: the model already chosen
    // takes them on at once, so a reload never leaves a stale vision flag.
    onSuccess: (result) => {
      if (!result.ok) return
      setModel((current) => {
        const info = result.models.find((m) => m.id === current.id)
        return info === undefined
          ? current
          : {
              id: current.id,
              supportsVision: effectiveFeatures(kind, info).vision,
            }
      })
    },
  })
  const listed = listing.data?.ok === true ? listing.data.models : null
  const choices = modelChoices(kind, listed)
  const selected = choices.find((m) => m.id === model.id)
  const features = effectiveFeatures(kind, selected)

  const generation = generationSchema(kind.profileFields)
  const advancedCommon = advancedCommonSchema(kind.profileFields)
  const missing = missingRequired(kind.connectionSchema, providerConfig)
  // A widget's own required keys: what it must have written before a save.
  const widgetIncomplete = widgets.some((w) =>
    (w.requires ?? []).some((key) => !isFilled(providerConfig[key])),
  )
  const canVerify = kind.modelCatalog === 'fetch' && modelWidget === null
  const hasConnection =
    fieldsOfSchema(kind.connectionSchema).length > 0 || connectionWidgets.length > 0

  const pickModel = (id: string): void => {
    const info = choices.find((m) => m.id === id)
    setModel({ id, supportsVision: effectiveFeatures(kind, info).vision })
  }

  const blocked =
    saving || name.trim() === '' || model.id.trim() === '' || missing.length > 0 || widgetIncomplete

  const save = (): void => {
    onSave(
      draftToProfile(kind, existing, {
        name: name.trim(),
        model: model.id.trim(),
        supportsVision: kind.visionEditable ? model.supportsVision : false,
        common,
        providerConfig,
      }),
    )
  }

  const title =
    existing !== null
      ? t('ai.editProfile', 'Edit {{name}}', { name: existing.name })
      : t('ai.newProfile', 'New {{kind}} profile', { kind: kind.label })

  const renderWidget = (id: string) => {
    const Widget = providerWidget(id)
    if (Widget === null) {
      return (
        <ErrorBox
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
        descriptor={kind}
        providerConfig={providerConfig}
        onProviderConfigChange={setProviderConfig}
        model={model}
        onModelChange={setModel}
      />
    )
  }

  return (
    <ItemFormDialog
      open
      onClose={onCancel}
      title={title}
      error={error}
      width="lg"
      testId="ai-profile-editor"
      footer={
        <>
          {missing.length > 0 && (
            <Badge variant="warning">
              {t('ai.missingRequired', 'required: {{fields}}', {
                fields: missing.join(', '),
              })}
            </Badge>
          )}
          {missing.length === 0 && widgetIncomplete && (
            <Badge variant="warning">
              {t('ai.completeProvider', 'complete the provider settings')}
            </Badge>
          )}
          {missing.length === 0 && !widgetIncomplete && model.id.trim() === '' && (
            <Badge variant="warning">{t('ai.pickModelFirst', 'pick a model')}</Badge>
          )}
          <Button size="sm" type="button" disabled={blocked} onClick={save}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {existing !== null
              ? t('ai.saveChanges', 'Save changes')
              : t('ai.createProfile', 'Create profile')}
          </Button>
        </>
      }
    >
      <div className={STACK_GAP}>
        {/* ① provider header */}
        <div className="flex flex-wrap items-center gap-2" data-testid="ai-editor-provider">
          <KindGlyph kind={kind} className="h-4 w-4 text-foreground-subtle" />
          <span className="text-xs font-medium text-foreground">{kind.label}</span>
          <Badge variant="neutral">{kind.addonId}</Badge>
          {onChangeKind !== undefined && (
            <Button size="sm" variant="ghost" type="button" onClick={onChangeKind}>
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('ai.changeKind', 'Change type')}
            </Button>
          )}
        </div>
        <FormField label={t('ai.name', 'Name')} required>
          <Input
            id="ai-profile-name"
            aria-label={t('ai.name', 'Name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind.label}
          />
        </FormField>

        {/* ② Connection */}
        {hasConnection && (
          <SectionCard
            headingId="ai-editor-connection"
            title={t('ai.sectionConnection', 'Connection')}
            actions={
              canVerify ? (
                <Button
                  size="sm"
                  variant="secondary"
                  type="button"
                  disabled={listing.isPending}
                  onClick={() => listing.mutate()}
                  data-testid="ai-verify-models"
                >
                  {listing.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {t('ai.verifyModels', 'Verify & load models')}
                </Button>
              ) : undefined
            }
          >
            <div className={`${SECTION_BODY} space-y-3`}>
              {fieldsOfSchema(kind.connectionSchema).length > 0 && (
                <ConfigFormBuilder
                  bare
                  schema={kind.connectionSchema}
                  values={providerConfig}
                  onChange={setProviderConfig}
                />
              )}
              {connectionWidgets.map((w) => renderWidget(w.id))}
              {hasStoredSecret && (
                <p className="text-[10px] text-foreground-subtle">
                  {t(
                    'ai.secretHint',
                    'A stored API key is never shown. Leave it as-is to keep it; type a new value to replace it.',
                  )}
                </p>
              )}
              {listing.data?.ok === true && (
                <Badge variant="success" data-testid="ai-models-found">
                  {t('ai.modelsFound', '{{count}} models found', {
                    count: listing.data.models.length,
                  })}
                </Badge>
              )}
              {listing.data?.ok === false && (
                <ErrorBox
                  title={t(
                    LIST_ERROR_TITLE[listing.data.code]?.key ?? 'ai.listNetwork',
                    LIST_ERROR_TITLE[listing.data.code]?.fallback ?? 'Endpoint unreachable',
                  )}
                  message={listing.data.message}
                />
              )}
              {listing.isError && (
                <ErrorBox
                  message={
                    listing.error instanceof Error
                      ? listing.error.message
                      : t('common.error', 'Error')
                  }
                />
              )}
            </div>
          </SectionCard>
        )}

        {/* ③ Model */}
        <SectionCard headingId="ai-editor-model" title={t('ai.sectionModel', 'Model')}>
          <div className={`${SECTION_BODY} space-y-3`}>
            {modelWidget !== null ? (
              renderWidget(modelWidget.id)
            ) : (
              <>
                {choices.length > 0 && (
                  <Select
                    id="ai-model-pick"
                    aria-label={t('ai.selectModel', 'Select a model…')}
                    value={selected !== undefined ? selected.id : ''}
                    options={[
                      {
                        value: '',
                        label: t('ai.selectModel', 'Select a model…'),
                      },
                      ...choices.map((m) => ({
                        value: m.id,
                        label: m.label ?? m.id,
                      })),
                    ]}
                    onChange={(e) => {
                      if (e.target.value !== '') pickModel(e.target.value)
                    }}
                  />
                )}
                <FormField
                  label={t('ai.customModel', 'Model id')}
                  description={t(
                    'ai.customModelHint',
                    'Pick one from the list, or type any model id the provider accepts.',
                  )}
                  required
                >
                  <Input
                    id="ai-model-id"
                    aria-label={t('ai.customModel', 'Model id')}
                    value={model.id}
                    onChange={(e) => setModel({ ...model, id: e.target.value })}
                    placeholder={choices[0]?.id ?? 'model-id'}
                  />
                </FormField>
              </>
            )}
            <div className="flex flex-wrap items-center gap-1.5" data-testid="ai-model-features">
              {(model.supportsVision || (!kind.visionEditable && features.vision)) && (
                <Badge variant="info">{t('ai.featureVision', 'vision')}</Badge>
              )}
              {features.tools && <Badge variant="neutral">{t('ai.featureTools', 'tools')}</Badge>}
              {features.streaming && (
                <Badge variant="neutral">{t('ai.featureStreaming', 'streaming')}</Badge>
              )}
            </div>
            {kind.visionEditable && (
              <FormField
                orientation="horizontal"
                label={t('ai.supportsVision', 'Supports vision')}
                description={t(
                  'ai.supportsVisionHint',
                  'A vision call against a text-only profile is refused, never downgraded.',
                )}
              >
                <Switch
                  checked={model.supportsVision}
                  onCheckedChange={(next) => setModel({ ...model, supportsVision: next })}
                  aria-label={t('ai.supportsVision', 'Supports vision')}
                />
              </FormField>
            )}
          </div>
        </SectionCard>

        {/* ④ Generation */}
        {generation !== null && (
          <SectionCard
            headingId="ai-editor-generation"
            title={t('ai.sectionGeneration', 'Generation')}
          >
            <div className={SECTION_BODY}>
              <ConfigFormBuilder bare schema={generation} values={common} onChange={setCommon} />
            </div>
          </SectionCard>
        )}

        {/* ▸ Advanced */}
        {(advancedCommon !== null || kind.advancedSchema !== undefined) && (
          <CollapsibleCard
            expanded={advancedOpen}
            onExpandedChange={setAdvancedOpen}
            header={
              <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
                {t('ai.sectionAdvanced', 'Advanced')}
              </span>
            }
          >
            <div className={`${SECTION_BODY} space-y-3`}>
              {advancedCommon !== null && (
                <ConfigFormBuilder
                  bare
                  schema={advancedCommon}
                  values={common}
                  onChange={setCommon}
                />
              )}
              {kind.advancedSchema !== undefined && (
                <ConfigFormBuilder
                  bare
                  schema={kind.advancedSchema}
                  values={providerConfig}
                  onChange={setProviderConfig}
                />
              )}
            </div>
          </CollapsibleCard>
        )}
      </div>
    </ItemFormDialog>
  )
}
