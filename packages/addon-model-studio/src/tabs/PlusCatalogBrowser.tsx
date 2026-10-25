/**
 * plus catalog account catalog: model group (base / custom) and release narrow
 * the list; below them EVERY architecture is a card at once — YOLO-NAS,
 * YOLOv9 and MobileDet side by side, no runtime filter. A card's chips pick
 * size and resolution, and the import row shows every format that exists for
 * that combination: ONNX (download), OpenVINO / CoreML (converted from the
 * ONNX) and TFLite (the EdgeTPU build, for a Coral). A format with no build
 * behind it is not shown; a TFLite with no Coral in the cluster is shown
 * blocked, with the reason.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import type { ModelFormat } from '@camstack/types'
import { plusCatalogPlusRegistryId, type PlusCatalogModelView } from '../ui/api.js'
import { ImportProgressModal } from '../components/ImportProgressModal.js'
import { FormatImportRow, type FormatRowEntry } from '../components/FormatImportRow.js'
import { FacetSelect } from '../components/register-shared.js'
import { SourceModelBrowser } from '../components/SourceModelBrowser.js'
import { TfliteGateNote, useTfliteNodes } from '../components/TfliteGate.js'
import {
  DisplayNameField,
  importNameOf,
  isDisplayNameInvalid,
} from '../components/DisplayNameField.js'
import {
  buildPlusCatalog,
  runnablePlusModels,
  type PlusCatalogCombo,
  type PlusFormatOffer,
} from '../plus-catalog/plus-catalog-as-variant-sources.js'
import { dimensionsOf, plusFacets, type PlusSelection } from '../plus-catalog/plus-catalog-api.js'
import { usePlusImport, type NodePresenceList } from './use-plus-import.js'
import { Trans, useT } from '../i18n/index.js'

type PlusT = ReturnType<typeof useT>['t']

type Trpc = AddonPageProps['trpc']

export interface PlusCatalogBrowserProps {
  readonly trpc: Trpc
  readonly models: readonly PlusCatalogModelView[]
  readonly onRegistered: (message: string) => void
  readonly onError: (message: string) => void
  readonly landNodeId?: string
}

const SELECTOR_LEVELS = ['kind', 'release'] as const
type SelectorLevel = (typeof SELECTOR_LEVELS)[number]

/** Fill each unset (or no longer offered) level with its first option. */
function withDefaults(
  models: readonly PlusCatalogModelView[],
  current: PlusSelection,
): PlusSelection {
  let next: PlusSelection = { ...current }
  for (const level of SELECTOR_LEVELS) {
    const options = plusFacets(models, next)[level]
    const chosen = next[level]
    const first = options[0]
    if (first !== undefined && (chosen === undefined || !options.some((o) => o.value === chosen))) {
      next =
        level === 'kind'
          ? { ...next, kind: first.value === 'base' ? 'base' : 'custom' }
          : { ...next, release: first.value }
    }
  }
  return next
}

/** Why a TFLite import cannot run right now, or `undefined` when it can. */
function coralBlockReason(tfliteNodes: readonly string[] | null, t: PlusT): string | undefined {
  if (tfliteNodes === null) return t('plus.checkingCoral')
  return tfliteNodes.length === 0 ? t('plus.needsCoral') : undefined
}

export function PlusCatalogBrowser({
  trpc,
  models,
  onRegistered,
  onError,
  landNodeId,
}: PlusCatalogBrowserProps) {
  const { t } = useT()
  const [sel, setSel] = useState<PlusSelection>({})
  const [variantId, setVariantId] = useState('')
  const imports = usePlusImport({
    trpc,
    onRegistered,
    onError,
    ...(landNodeId !== undefined ? { landNodeId } : {}),
  })

  const runnable = useMemo(() => runnablePlusModels(models), [models])
  const effective = withDefaults(runnable, sel)
  const facets = plusFacets(runnable, {
    kind: effective.kind,
    release: effective.release,
  })
  const catalog = useMemo(
    () => buildPlusCatalog(facets.entries),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runnable, effective.kind, effective.release],
  )
  const offersTflite = useMemo(
    () =>
      [...catalog.combos.values()].some((c) =>
        c.trainings.some((tr) => tr.offers.some((o) => o.format === 'tflite')),
      ),
    [catalog],
  )
  const tfliteNodes = useTfliteNodes(trpc, offersTflite)

  const pick = (level: SelectorLevel, value: string): void => {
    setSel(
      level === 'kind'
        ? { kind: value === 'base' ? 'base' : 'custom' }
        : {
            ...(effective.kind !== undefined ? { kind: effective.kind } : {}),
            release: value,
          },
    )
    setVariantId('')
  }

  if (runnable.length === 0) {
    return <div className="text-[11px] text-foreground-subtle">{t('plus.empty')}</div>
  }

  const chipId = catalog.combos.has(variantId) ? variantId : ''

  return (
    <>
      {imports.modal !== null && (
        <ImportProgressModal
          title={imports.modal.title}
          steps={imports.modal.steps}
          progress={imports.modal.progress}
          logs={imports.modal.logs}
          status={imports.modal.status}
          {...(imports.modal.errorMessage !== undefined
            ? { errorMessage: imports.modal.errorMessage }
            : {})}
          onClose={imports.closeModal}
        />
      )}
      <SourceModelBrowser
        testId="plus-catalog-browser"
        preSelectors={[
          {
            id: 'kind',
            label: t('plus.modelGroup'),
            value: effective.kind ?? '',
            options: facets.kind.map((o) => ({
              ...o,
              label: o.value === 'base' ? t('plus.kind.base') : t('plus.kind.custom'),
            })),
            onChange: (value) => pick('kind', value),
            compactWhenSingle: true,
          },
          {
            id: 'release',
            label: t('plus.release'),
            value: effective.release ?? '',
            options: facets.release,
            onChange: (value) => pick('release', value),
            compactWhenSingle: true,
          },
        ]}
        catalog={catalog.sources}
        value={chipId}
        onChange={setVariantId}
        emptyMessage={t('plus.emptyRelease')}
        renderActionRow={(sourceId) => {
          const combo = catalog.combos.get(sourceId)
          if (combo === undefined) return null
          return (
            <PlusComboImportPanel
              key={sourceId}
              combo={combo}
              tfliteNodes={tfliteNodes}
              registeredIds={imports.registeredIds}
              registryFormats={imports.registryFormats}
              presenceByModel={imports.presenceByModel}
              busyId={imports.busyId}
              onImport={(offer, title, operatorName) =>
                void imports.runImportFormat(offer.plusModelId, offer.format, title, operatorName)
              }
            />
          )
        }}
      />
    </>
  )
}

const entryIdOf = (offer: PlusFormatOffer): string =>
  `${plusCatalogPlusRegistryId(offer.plusModelId)}::${offer.format}`

interface PlusComboImportPanelProps {
  readonly combo: PlusCatalogCombo
  readonly tfliteNodes: readonly string[] | null
  readonly registeredIds: ReadonlySet<string> | null
  readonly registryFormats: Readonly<Record<string, readonly ModelFormat[]>>
  readonly presenceByModel: Readonly<Record<string, NodePresenceList>>
  readonly busyId: string | null
  readonly onImport: (offer: PlusFormatOffer, title: string, operatorName?: string) => void
}

export function PlusComboImportPanel({
  combo,
  tfliteNodes,
  registeredIds,
  registryFormats,
  presenceByModel,
  busyId,
  onImport,
}: PlusComboImportPanelProps) {
  const { t } = useT()
  const [trainingKey, setTrainingKey] = useState(combo.trainings[0]?.key ?? '')
  const [name, setName] = useState('')
  useEffect(() => {
    setTrainingKey(combo.trainings[0]?.key ?? '')
  }, [combo])

  const training = combo.trainings.find((tr) => tr.key === trainingKey) ?? combo.trainings[0]
  const lead = training?.builds[0]
  if (training === undefined || lead === undefined) return null

  const hasNeural = training.offers.some((o) => o.format === 'onnx')
  const hasTflite = training.offers.some((o) => o.format === 'tflite')
  const blockedTflite = coralBlockReason(tfliteNodes, t)
  const entries: FormatRowEntry[] = training.offers.map((offer) => ({
    id: entryIdOf(offer),
    format: offer.format,
    driftStatus: offer.needsCoral ? (blockedTflite ?? 'ok') : 'ok',
  }))
  const registryIds = [
    ...new Set(training.offers.map((o) => plusCatalogPlusRegistryId(o.plusModelId))),
  ]
  const presence = registryIds.flatMap((id) => presenceByModel[id] ?? [])
  const title = `${combo.name}${combo.resolution !== undefined ? ` ${combo.resolution}` : ''}`

  return (
    <div className="space-y-3" data-testid="plus-combo-panel" data-combo={combo.sourceId}>
      {combo.trainings.length > 1 && (
        <FacetSelect
          label={t('plus.training')}
          value={training.key}
          options={combo.trainings.map((tr) => ({
            value: tr.key,
            label: `${tr.key}${
              tr.verifiedImages > 0 ? t('plus.verifiedSuffix', { count: tr.verifiedImages }) : ''
            }`,
          }))}
          onChange={setTrainingKey}
        />
      )}

      <div className="rounded-md border border-border bg-surface px-3 py-2 text-[11px] text-foreground-subtle break-words">
        <Trans
          i18nKey="plus.summary"
          values={{
            name: lead.name,
            release: lead.baseModel,
            decode: lead.type,
            input: dimensionsOf(lead).replace('x', '×'),
          }}
          components={{
            name: <span className="text-foreground" />,
            mono: <span className="font-mono" />,
          }}
        />
        {training.verifiedImages > 0
          ? t('plus.verifiedSuffix', { count: training.verifiedImages })
          : null}
        {hasNeural && <span className="block pt-0.5">{t('plus.onnxNote')}</span>}
        {hasTflite && <span className="block pt-0.5">{t('plus.tfliteNote')}</span>}
      </div>
      {hasTflite && <TfliteGateNote nodes={tfliteNodes} />}

      <DisplayNameField value={name} onChange={setName} defaultName={lead.name} />

      <FormatImportRow
        entries={entries}
        registeredIds={registeredIds}
        isImported={(e) => {
          const registryId = e.id.split('::')[0] ?? ''
          return (registryFormats[registryId] ?? []).includes(e.format)
        }}
        presence={presence}
        busyId={busyId}
        onImport={(id) => {
          const offer = training.offers.find((o) => entryIdOf(o) === id)
          if (offer === undefined || isDisplayNameInvalid(name)) return
          onImport(offer, title, importNameOf(name))
        }}
      />
    </div>
  )
}
