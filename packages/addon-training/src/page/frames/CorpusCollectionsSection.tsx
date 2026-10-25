/**
 * Named collections between the KPI strip and the filter bar — create / rename /
 * delete. Selecting a collection also sets the single-select collection filter.
 */
import type { RetrainCollection } from '@camstack/types'
import { SectionCard, SECTION_BODY } from '@camstack/ui-library'
import type { JSX } from 'react'
import { useT, type TFn } from '../../i18n/index.js'
import { RetrainCollectionsList } from './RetrainCollectionsList.js'

/** The sentence for a refused create / rename; an unknown reason answers itself. */
export function collectionRefusalText(t: TFn, reason: string): string {
  switch (reason) {
    case 'empty-name':
      return t('collections.refusal.emptyName')
    case 'duplicate-name':
      return t('collections.refusal.duplicateName')
    case 'unknown-collection':
      return t('collections.refusal.unknown')
    default:
      return reason
  }
}

export interface CorpusCollectionsSectionProps {
  readonly collections: readonly RetrainCollection[] | undefined
  readonly isLoading: boolean
  readonly selectedId: string | null
  readonly onSelect: (collection: RetrainCollection) => void
  readonly onCreate: (name: string) => Promise<string | null>
  readonly onRename: (id: string, name: string) => Promise<string | null>
  readonly onDelete: (id: string) => Promise<void>
}

export function CorpusCollectionsSection({
  collections,
  isLoading,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: CorpusCollectionsSectionProps): JSX.Element {
  const { t } = useT()
  return (
    <SectionCard
      headingId="corpus-collections-heading"
      title={t('collections.title')}
      testId="corpus-collections"
    >
      <div className={SECTION_BODY}>
        <RetrainCollectionsList
          collections={collections ?? []}
          isLoading={isLoading}
          selectedId={selectedId}
          onSelect={onSelect}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
        />
      </div>
    </SectionCard>
  )
}
