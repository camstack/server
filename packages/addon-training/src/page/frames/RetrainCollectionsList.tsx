/**
 * The named collections — the second worklist of the Retrain page.
 *
 * A collection is a named set over the retrain corpus: frames copied from
 * tracks and frames taken from the recording ("Send frame to training" on a
 * camera's recording timeline). Here the operator creates, renames and deletes
 * them and picks the one to work.
 *
 * Deleting says what it does: the collection's recording frames that no other
 * collection holds are deleted with their boxes (nothing else reaches them);
 * frames copied from tracks stay in the dataset.
 */

import type { RetrainCollection } from '@camstack/types'
import { Badge, Button, ConfirmActionButton, Input } from '@camstack/ui-library'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n/index.js'

interface RetrainCollectionsListProps {
  readonly collections: readonly RetrainCollection[]
  readonly isLoading: boolean
  readonly selectedId: string | null
  readonly onSelect: (collection: RetrainCollection) => void
  readonly onCreate: (name: string) => Promise<string | null>
  readonly onRename: (id: string, name: string) => Promise<string | null>
  readonly onDelete: (id: string) => Promise<void>
}

export function RetrainCollectionsList({
  collections,
  isLoading,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: RetrainCollectionsListProps) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)

  const create = async (): Promise<void> => {
    const refusal = await onCreate(name)
    setError(refusal)
    if (refusal === null) setName('')
  }
  const rename = async (): Promise<void> => {
    if (editing === null) return
    const refusal = await onRename(editing.id, editing.name)
    setError(refusal)
    if (refusal === null) setEditing(null)
  }

  return (
    <div className="divide-y divide-border">
      <div className="p-2 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Input
            className="flex-1"
            aria-label={t('collectionsList.newName')}
            placeholder={t('collectionsList.newPlaceholder')}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
          <Button size="sm" disabled={name.trim() === ''} onClick={() => void create()}>
            {t('collectionsList.create')}
          </Button>
        </div>
        {error !== null && <p className="text-[11px] text-danger">{error}</p>}
      </div>
      {collections.length === 0 ? (
        <p className="p-3 text-[11px] text-foreground-subtle">
          {isLoading ? t('collectionsList.reading') : t('collectionsList.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {collections.map((collection) => (
            <li
              key={collection.id}
              className={`px-3 py-2 flex items-center gap-2 text-xs ${collection.id === selectedId ? 'bg-surface-hover' : ''}`}
            >
              {editing?.id === collection.id ? (
                <>
                  <Input
                    className="flex-1"
                    aria-label={t('collectionsList.name')}
                    value={editing.name}
                    onChange={(event) => {
                      setEditing({ id: collection.id, name: event.target.value })
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('collectionsList.saveName')}
                    onClick={() => void rename()}
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('collectionsList.cancelRename')}
                    onClick={() => {
                      setEditing(null)
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="unstyled"
                    type="button"
                    className="flex-1 min-w-0 text-left truncate text-foreground"
                    onClick={() => {
                      onSelect(collection)
                    }}
                  >
                    {collection.name}
                  </Button>
                  <Badge>{collection.frameCount}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('collectionsList.rename', { name: collection.name })}
                    onClick={() => {
                      setEditing({ id: collection.id, name: collection.name })
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <ConfirmActionButton
                    label={t('common.delete')}
                    icon={Trash2}
                    triggerVariant="ghost"
                    size="sm"
                    title={t('collectionsList.deleteTitle', { name: collection.name })}
                    description={t('collectionsList.deleteDescription')}
                    confirmLabel={t('common.delete')}
                    confirmVariant="danger"
                    action={() => onDelete(collection.id)}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
