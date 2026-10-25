/**
 * <TrainingCollectionPicker> — choose a named training collection, or create
 * one in place.
 *
 * A collection is a named set over the retrain corpus ("packages porch
 * night"). The picker lists them (newest first, with their frame counts) and
 * offers a name field for a new one; the hub refuses an empty or duplicate
 * name, and the refusal is shown here rather than swallowed.
 */
import { Plus } from 'lucide-react'
import { useState, type JSX } from 'react'
import {
  usePipelineAnalyticsCreateRetrainCollection,
  usePipelineAnalyticsListRetrainCollections,
} from '../../generated/system-hooks'
import { useUiText } from '../../contexts/ui-text'
import { Button } from '../../primitives/button'
import { Input } from '../../primitives/input'
import { Select } from '../../primitives/select'

export interface TrainingCollectionPickerProps {
  readonly value: string | null
  readonly onChange: (collectionId: string) => void
}

type CreateRefusal = 'empty-name' | 'duplicate-name'

export function TrainingCollectionPicker({
  value,
  onChange,
}: TrainingCollectionPickerProps): JSX.Element {
  const t = useUiText()
  const collections = usePipelineAnalyticsListRetrainCollections({})
  const create = usePipelineAnalyticsCreateRetrainCollection()
  const [name, setName] = useState('')
  const [error, setError] = useState<CreateRefusal | null>(null)

  const list = collections.data ?? []
  const onCreate = async (): Promise<void> => {
    setError(null)
    const result = await create.mutateAsync({ name })
    if (result.kind === 'refused') {
      setError(result.reason)
      return
    }
    setName('')
    await collections.refetch()
    onChange(result.collection.id)
  }

  return (
    <div className="space-y-2" data-testid="training-collection-picker">
      {list.length > 0 ? (
        <Select
          aria-label={t('uiLibrary.trainingCollectionPicker.collection', 'Collection')}
          value={value ?? ''}
          options={[
            {
              value: '',
              label: t('uiLibrary.trainingCollectionPicker.choose', 'Choose a collection…'),
            },
            ...list.map((c) => ({
              value: c.id,
              label: `${c.name} (${String(c.frameCount)})`,
            })),
          ]}
          onChange={(event) => {
            if (event.target.value !== '') onChange(event.target.value)
          }}
        />
      ) : (
        <p className="text-xs text-foreground-subtle">
          {collections.isLoading
            ? t('uiLibrary.trainingCollectionPicker.reading', 'Reading the collections…')
            : t('uiLibrary.trainingCollectionPicker.none', 'No collection yet — create one.')}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          aria-label={t('uiLibrary.trainingCollectionPicker.newName', 'New collection name')}
          placeholder={t(
            'uiLibrary.trainingCollectionPicker.newPlaceholder',
            'New collection (e.g. missed at night)',
          )}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={create.isPending || name.trim() === ''}
          onClick={() => void onCreate()}
        >
          <Plus className="h-3 w-3" />
          {t('uiLibrary.trainingCollectionPicker.create', 'Create')}
        </Button>
      </div>
      {error !== null && (
        <p className="text-xs text-danger">
          {error === 'empty-name'
            ? t('uiLibrary.trainingCollectionPicker.emptyName', 'Give the collection a name.')
            : t(
                'uiLibrary.trainingCollectionPicker.duplicateName',
                'A collection with that name already exists.',
              )}
        </p>
      )}
    </div>
  )
}
