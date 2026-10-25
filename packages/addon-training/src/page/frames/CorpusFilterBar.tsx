/**
 * Frames filter bar: work-state chips (CHIP_*), multi camera, single collection,
 * multi annotated classes, plus Export for the current filter set.
 */
import type { RetrainCollection, RetrainFrameWorkState, RetrainMacroClass } from '@camstack/types'
import {
  Button,
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  DevicePicker,
  Select,
  cn,
  deviceListStateOf,
  hubPath,
  usePipelineAnalyticsGetRetrainExportUrl,
  type PickerItem,
} from '@camstack/ui-library'
import { Download, Loader2 } from 'lucide-react'
import { useMemo, useState, type JSX } from 'react'
import { useT } from '../../i18n/index.js'
import type { CorpusUrlFilter } from './corpus-filter-url.js'
import { authedDownload } from './lib/authed-download.js'

const WORK_STATE_CHOICES: readonly {
  readonly value: RetrainFrameWorkState | undefined
  readonly labelKey: 'all' | 'unannotated' | 'annotated' | 'complete'
}[] = [
  { value: undefined, labelKey: 'all' },
  { value: 'unannotated', labelKey: 'unannotated' },
  { value: 'annotated', labelKey: 'annotated' },
  { value: 'complete', labelKey: 'complete' },
]

const MACRO_CLASS_CHOICES: readonly RetrainMacroClass[] = [
  'person',
  'vehicle',
  'animal',
  'package',
  'face',
  'plate',
]

export interface CorpusFilterBarProps {
  readonly filter: CorpusUrlFilter
  readonly onChange: (next: CorpusUrlFilter) => void
  readonly cameraItems: readonly PickerItem<number>[]
  readonly camerasListState: ReturnType<typeof deviceListStateOf>
  readonly collections: readonly RetrainCollection[] | undefined
  readonly collectionsPending: boolean
}

function workStateKey(value: RetrainFrameWorkState | undefined): string {
  return value ?? 'all'
}

export function CorpusFilterBar({
  filter,
  onChange,
  cameraItems,
  camerasListState,
  collections,
  collectionsPending,
}: CorpusFilterBarProps): JSX.Element {
  const { t } = useT()
  const exportInput = useMemo(
    () => ({
      ...(filter.workState !== undefined ? { workState: filter.workState } : {}),
      ...(filter.deviceIds.length > 0 ? { deviceIds: [...filter.deviceIds] } : {}),
      ...(filter.collectionId !== undefined ? { collectionId: filter.collectionId } : {}),
      ...(filter.classes.length > 0 ? { classes: [...filter.classes] } : {}),
    }),
    [filter],
  )
  const exportUrl = usePipelineAnalyticsGetRetrainExportUrl(exportInput)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const collectionOptions = useMemo(() => {
    const list = collections ?? []
    return [
      {
        value: '',
        label: collectionsPending
          ? t('corpus.filter.readingCollections')
          : t('corpus.filter.anyCollection'),
      },
      ...list.map((c) => ({
        value: c.id,
        label: `${c.name} (${String(c.frameCount)})`,
      })),
    ]
  }, [collections, collectionsPending, t])

  const patch = (partial: Partial<CorpusUrlFilter>): void => {
    onChange({
      ...filter,
      ...partial,
      // Any filter change other than page itself resets to page 1.
      page: partial.page !== undefined ? partial.page : 1,
    })
  }

  const toggleClass = (cls: RetrainMacroClass): void => {
    const has = filter.classes.includes(cls)
    patch({
      classes: has ? filter.classes.filter((c) => c !== cls) : [...filter.classes, cls],
    })
  }

  const onExport = async (): Promise<void> => {
    if (exportUrl.data === undefined) return
    setExporting(true)
    setExportError(null)
    try {
      await authedDownload(hubPath(exportUrl.data.url), 'camstack-retrain-export.tar')
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="corpus-filter-bar">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('corpus.filter.workState')}
          data-testid="corpus-work-state-filter"
        >
          {WORK_STATE_CHOICES.map((choice) => {
            const active = workStateKey(filter.workState) === workStateKey(choice.value)
            return (
              // ui-check-ok: CHIP_* filter pill (Model Studio Installed pattern)
              <button
                key={workStateKey(choice.value)}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  patch({ workState: choice.value })
                }}
                className={cn(CHIP_BASE, 'px-2', active ? CHIP_ACTIVE : CHIP_INACTIVE)}
              >
                {t(`corpus.filter.workStates.${choice.labelKey}`)}
              </button>
            )
          })}
        </div>

        <div className="min-w-0 flex-1 basis-full sm:basis-64">
          <DevicePicker
            devices={cameraItems}
            listState={camerasListState}
            value={filter.deviceIds}
            onChange={(next) => {
              patch({ deviceIds: next })
            }}
            emptyLabel={t('corpus.filter.anyCamera')}
            noun="camera"
            testId="corpus-camera-filter"
          />
        </div>

        <div className="w-full min-w-0 sm:w-52">
          <Select
            aria-label={t('corpus.filter.collection')}
            data-testid="corpus-collection-filter"
            value={filter.collectionId ?? ''}
            options={collectionOptions}
            onChange={(event) => {
              const value = event.target.value
              patch({ collectionId: value === '' ? undefined : value })
            }}
          />
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={exportUrl.data === undefined || exporting}
          onClick={() => {
            void onExport()
          }}
          data-testid="corpus-export"
        >
          {exporting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          <span className="ml-1">{t('corpus.filter.export')}</span>
        </Button>
      </div>

      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label={t('corpus.filter.annotatedClasses')}
        data-testid="corpus-class-filter"
      >
        {MACRO_CLASS_CHOICES.map((cls) => {
          const active = filter.classes.includes(cls)
          return (
            // ui-check-ok: CHIP_* multi-select class filter pill
            <button
              key={cls}
              type="button"
              aria-pressed={active}
              onClick={() => {
                toggleClass(cls)
              }}
              className={cn(CHIP_BASE, 'px-2 capitalize', active ? CHIP_ACTIVE : CHIP_INACTIVE)}
            >
              {cls}
            </button>
          )
        })}
      </div>

      {exportError !== null ? (
        <p className="text-[11px] text-danger" role="alert">
          {exportError}
        </p>
      ) : null}
    </div>
  )
}
