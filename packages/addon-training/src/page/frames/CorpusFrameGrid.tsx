/**
 * Paginated thumbnail grid of corpus copies. Pending ≠ empty (D315).
 * Click reports `onOpenFrame` so FramesSection can open the annotate overlay.
 */
import type { RetrainCorpusPageFrame } from '@camstack/types'
import {
  Badge,
  EmptyState,
  PageSizeSelect,
  Pagination,
  Skeleton,
  hubPath,
} from '@camstack/ui-library'
import { ImageIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useT } from '../../i18n/index.js'
import { corpusFrameBadge } from './corpus-frame-badge.js'
import { useAuthedImage } from './lib/authed-image.js'
import { RetrainFrameChips } from './RetrainFrameChips.js'

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const

export interface CorpusFrameGridProps {
  readonly frames: readonly RetrainCorpusPageFrame[] | undefined
  readonly total: number | undefined
  readonly page: number
  readonly pageSize: number
  readonly isLoading: boolean
  readonly isError: boolean
  readonly deviceNames: ReadonlyMap<number, string>
  readonly onPageChange: (page: number) => void
  readonly onPageSizeChange: (size: number) => void
  readonly onOpenFrame: (frameId: string) => void
}

function CorpusFrameThumb({
  frame,
  cameraName,
  onOpen,
}: {
  readonly frame: RetrainCorpusPageFrame
  readonly cameraName: string
  readonly onOpen: () => void
}): JSX.Element {
  const { t } = useT()
  // A thumbnail over the admin data plane — never the full frame as base64.
  const image = useAuthedImage(
    frame.thumbnailUrl !== undefined ? hubPath(frame.thumbnailUrl) : undefined,
  )
  const badge = corpusFrameBadge(frame.workState)
  const src = image.src ?? undefined

  return (
    <button // ui-check-ok: thumbnail tile hit target; Button chrome breaks the grid cell
      type="button"
      className="group flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface text-left hover:border-primary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
      onClick={onOpen}
      data-testid={`corpus-frame-${frame.frameId}`}
    >
      <div className="relative aspect-video bg-background">
        {src !== undefined ? (
          // eslint-disable-next-line @next/next/no-img-element -- object URL of the authed thumbnail
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-foreground-subtle">
            {frame.thumbnailUrl !== undefined && !image.failed ? (
              <Skeleton className="h-full w-full rounded-none" />
            ) : (
              <ImageIcon className="h-6 w-6" />
            )}
          </div>
        )}
        <RetrainFrameChips review={frame.review} />
        <div className="absolute left-1 top-1">
          <Badge variant={badge.variant} style="fill">
            {t(`corpus.badge.${badge.labelKey}`)}
          </Badge>
        </div>
      </div>
      <div className="truncate px-2 py-1.5 text-[11px] text-foreground-muted">{cameraName}</div>
    </button>
  )
}

export function CorpusFrameGrid({
  frames,
  total,
  page,
  pageSize,
  isLoading,
  isError,
  deviceNames,
  onPageChange,
  onPageSizeChange,
  onOpenFrame,
}: CorpusFrameGridProps): JSX.Element {
  const { t } = useT()
  const answered = frames !== undefined && total !== undefined

  return (
    <div className="space-y-3" data-testid="corpus-frame-grid">
      {isLoading && !answered ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="aspect-video rounded-md" />
          ))}
        </div>
      ) : null}

      {isError && !answered ? (
        <p className="text-xs text-danger" role="alert">
          {t('corpus.grid.couldNotLoad')}
        </p>
      ) : null}

      {answered && frames.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title={t('corpus.grid.emptyTitle')}
          description={t('corpus.grid.emptyDescription')}
        />
      ) : null}

      {answered && frames.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {frames.map((frame) => (
            <CorpusFrameThumb
              key={frame.frameId}
              frame={frame}
              cameraName={
                deviceNames.get(frame.deviceId) ??
                t('corpus.grid.cameraFallback', { id: frame.deviceId })
              }
              onOpen={() => {
                onOpenFrame(frame.frameId)
              }}
            />
          ))}
        </div>
      ) : null}

      {answered ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PageSizeSelect
            value={pageSize}
            options={PAGE_SIZE_OPTIONS}
            onChange={onPageSizeChange}
            ariaLabel={t('corpus.grid.perPage')}
          />
          <Pagination
            currentPage={page}
            totalItems={total}
            pageSize={pageSize}
            onPageChange={onPageChange}
            itemNoun={t('corpus.grid.itemNoun')}
          />
        </div>
      ) : null}
    </div>
  )
}
