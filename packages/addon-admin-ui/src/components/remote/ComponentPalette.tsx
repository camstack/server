/**
 * The "Add component" palette of the template editor (D973): the components
 * the `remote-layout-components` cap serves — a power key, a D-pad with OK, a
 * keypad, a volume rocker … — each with a small preview. Picking one hands it
 * to the editor, which puts it on the grid. The list is concat-fanned across
 * providers, so it is merged and de-duplicated here (`mergeComponents`); a
 * query that has not answered is a loading state, never an empty palette. The
 * palette stays open after a pick, so several components go on in one visit;
 * a line under the search says what was just added.
 */
import type { RemoteLayoutComponent, RemoteLayoutPayload } from '@camstack/types'
import {
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorBox,
  Input,
  Skeleton,
  useRemoteLayoutComponentsListComponents,
} from '@camstack/ui-library'
import { Search, Shapes } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  canFillWidth,
  componentName,
  componentPreview,
  filterComponents,
  mergeComponents,
} from './layout-components'
import { RemoteGrid } from './RemoteGrid'

export interface ComponentPaletteProps {
  readonly open: boolean
  /** The grid the component will go on: decides whether "stretch to full width" is offered. */
  readonly grid: RemoteLayoutPayload
  readonly onOpenChange: (open: boolean) => void
  readonly onPick: (component: RemoteLayoutComponent, options: { fillWidth: boolean }) => void
}

export function ComponentPalette({
  open,
  grid,
  onOpenChange,
  onPick,
}: ComponentPaletteProps): ReactNode {
  const { t, i18n } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('remote.palette.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {open && <PaletteBody grid={grid} language={i18n.language} onPick={onPick} />}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

interface BodyProps {
  readonly grid: RemoteLayoutPayload
  readonly language: string
  readonly onPick: ComponentPaletteProps['onPick']
}

function PaletteBody({ grid, language, onPick }: BodyProps): ReactNode {
  const { t } = useTranslation()
  const query = useRemoteLayoutComponentsListComponents({})
  const [search, setSearch] = useState('')
  const [fillWidth, setFillWidth] = useState(false)
  const [added, setAdded] = useState<string | null>(null)
  const categoryLabel = (category: string): string =>
    t(`remote.palette.category.${category}`, category)
  const components = useMemo(
    () => mergeComponents(query.data === undefined ? [] : [query.data]),
    [query.data],
  )
  const shown = filterComponents(components, search, language, categoryLabel)
  const anyStretchable = shown.some((c) => canFillWidth(grid, c))

  if (query.isError) {
    return (
      <ErrorBox
        title={t('remote.palette.errorTitle')}
        message={query.error.message}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (query.data === undefined) {
    return (
      <div className="grid gap-2 sm:grid-cols-2" data-testid="palette-loading">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle"
          aria-hidden
        />
        <Input
          value={search}
          className="pl-8"
          placeholder={t('remote.palette.search')}
          aria-label={t('remote.palette.search')}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="palette-search"
        />
      </div>
      {anyStretchable && (
        <label className="flex items-center gap-2 text-xs text-foreground-muted">
          <Checkbox
            checked={fillWidth}
            onChange={(e) => setFillWidth(e.target.checked)}
            data-testid="palette-fill-width"
          />
          {t('remote.palette.fillWidth')}
        </label>
      )}
      {added !== null && (
        <p role="status" className="text-xs text-success" data-testid="palette-added">
          {t('remote.palette.added', { name: added })}
        </p>
      )}
      {shown.length === 0 ? (
        <EmptyState
          icon={Shapes}
          title={t('remote.palette.emptyTitle')}
          description={t('remote.palette.emptyDescription')}
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="palette-list">
          {shown.map((component) => (
            <li key={component.id}>
              <PaletteItem
                component={component}
                language={language}
                category={categoryLabel(component.category)}
                onPick={() => {
                  onPick(component, { fillWidth })
                  setAdded(componentName(component, language))
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface ItemProps {
  readonly component: RemoteLayoutComponent
  readonly language: string
  readonly category: string
  readonly onPick: () => void
}

function PaletteItem({ component, language, category, onPick }: ItemProps): ReactNode {
  const { t } = useTranslation()
  const preview = useMemo(() => componentPreview(component), [component])
  const name = componentName(component, language)
  return (
    // ui-check-ok: a selectable preview card (thumbnail + text), not a labelled action button
    <button
      type="button"
      className="flex h-full w-full items-center gap-3 rounded-lg border border-border bg-surface p-2 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-testid={`palette-item-${component.id}`}
      onClick={onPick}
    >
      <span className="w-20 shrink-0">
        {preview !== null && <RemoteGrid grid={preview} label={name} compact />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        <span className="block truncate text-xs text-foreground-muted">
          {category} ·{' '}
          {t('remote.palette.size', {
            cols: component.size.cols,
            rows: component.size.rows,
          })}
        </span>
      </span>
    </button>
  )
}
