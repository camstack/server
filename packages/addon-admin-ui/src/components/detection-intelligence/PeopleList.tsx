/**
 * PeopleList — manage face-recognition identities (people).
 *
 * - DataTable of identities (cover, name, sample count)
 * - Create / rename via ItemFormDialog; URL `?new=1` / `?edit=<id>` (useItemFormUrl)
 * - Edit dialog also hosts the per-identity samples grid (remove samples)
 * - Delete asks through useConfirm
 * - "Enrol from a photo" keeps the PhotoEnrollDialog path
 */

import {
  Badge,
  Button,
  DataTable,
  DataTableFilterBar,
  EmptyState,
  FormField,
  IconButton,
  Input,
  ItemFormDialog,
  TABLE_SCROLL_MAX_H,
  useConfirm,
  useDataTableFilter,
  useFaceGalleryCreateIdentity,
  useFaceGalleryDeleteIdentity,
  useFaceGalleryListIdentities,
  useFaceGalleryListIdentitySamples,
  useFaceGalleryRemoveSample,
  useFaceGalleryRenameIdentity,
  useItemFormUrl,
  type DataColumn,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Loader2, Pencil, Plus, Trash2, UserRound, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { MediaIdImage } from './MediaIdImage.js'
import { PhotoEnrollDialog } from './PhotoEnrollDialog'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

// Local type definitions (mirror face-gallery capability schema)
interface Identity {
  id: string
  name: string
  sampleCount: number
  coverMediaId?: number
  coverBase64?: string
}

interface IdentitySampleInfo {
  id: string
  source: 'detected' | 'photo'
  addedAt: number
  deviceId?: number
  base64?: string
}

const FACE_GALLERY_KEY = [['faceGallery']]

// ── Samples sub-component (lazy) ────────────────────────────────────────────

interface SamplesGridProps {
  readonly identityId: string
}

function SamplesGrid({ identityId }: SamplesGridProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: samples, isLoading } = useFaceGalleryListIdentitySamples({
    identityId,
  })
  const removeSample = useFaceGalleryRemoveSample()

  function handleRemove(sample: IdentitySampleInfo) {
    removeSample.mutate(
      { identityId, sampleId: sample.id },
      {
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
        },
      },
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('detectionIntelligence.peopleList.loadingSamples', 'Loading samples…')}
      </div>
    )
  }

  if (!samples || samples.length === 0) {
    return (
      <p className="py-2 text-xs text-foreground-subtle">
        {t('detectionIntelligence.peopleList.noSamplesYet', 'No samples yet.')}
      </p>
    )
  }

  return (
    <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
      {samples.map((sample) => (
        <div
          key={sample.id}
          className="group relative aspect-square overflow-hidden rounded-md border border-border bg-surface"
        >
          {sample.base64 ? (
            <img
              src={`data:image/jpeg;base64,${sample.base64}`}
              alt={t('detectionIntelligence.peopleList.sample', 'Sample')}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-foreground-subtle">
              <UserRound className="h-6 w-6" />
            </div>
          )}
          {/* Where the sample CAME FROM, on the tile. A photo sample carries its
              original photograph beside its crop, so it can be re-embedded onto
              another model; a detected one cannot once footage has aged out.
              After 2026-08-17 that is the difference between a gallery that
              survives a model change and one that does not (D196/D197), so it
              has to be visible per sample and not only in aggregate. */}
          {sample.source === 'photo' && (
            <span
              className="absolute left-1 top-1 rounded bg-black/60 p-0.5 text-white"
              title={t(
                'detectionIntelligence.peopleList.enrolledFromAnUploadedPhoto',
                'Enrolled from an uploaded photo',
              )}
            >
              <ImagePlus className="h-3 w-3" />
            </span>
          )}
          <button // ui-check-ok: full-tile remove overlay; IconButton chrome fights the hit target
            type="button"
            onClick={() => handleRemove(sample)}
            disabled={removeSample.isPending}
            className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 disabled:cursor-not-allowed"
            aria-label={t('detectionIntelligence.peopleList.removeSample', 'Remove sample')}
          >
            <X className="h-4 w-4 text-white" />
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Columns ───────────────────────────────────────────────────────────────────

interface PeopleColumnsDeps {
  readonly onEdit: (identity: Identity) => void
  readonly onDelete: (identity: Identity) => void
}

function peopleColumns(deps: PeopleColumnsDeps): readonly DataColumn<Identity>[] {
  return [
    {
      key: 'person',
      header: i18n.t('detectionIntelligence.peopleList.person', 'Person'),
      sortValue: (identity) => identity.name,
      render: (identity) => (
        <span className="flex min-w-0 items-center gap-2">
          {/* Cover avatar — off the event-media plane by `coverMediaId`, so the
              browser caches it `immutable` instead of re-reading ~10 KB of base64
              out of every `listIdentities` response. `coverBase64` stays as the
              fallback for a hub that sends no id. */}
          <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-border bg-surface-hover">
            <MediaIdImage
              mediaId={identity.coverMediaId}
              base64={identity.coverBase64}
              alt={identity.name}
              className="h-full w-full object-cover"
              placeholder={
                <span className="flex h-full w-full items-center justify-center">
                  <UserRound className="h-4 w-4 text-foreground-subtle" />
                </span>
              }
            />
          </span>
          <span className="truncate text-sm font-medium text-foreground">{identity.name}</span>
        </span>
      ),
    },
    {
      key: 'samples',
      header: i18n.t('detectionIntelligence.peopleList.samples', 'Samples'),
      align: 'center',
      nowrap: true,
      sortValue: (identity) => identity.sampleCount,
      render: (identity) => (
        <Badge variant="default" className="text-[10px]">
          {identity.sampleCount}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      nowrap: true,
      notSortableReason: 'Actions',
      render: (identity) => (
        <span className="flex items-center justify-end gap-1">
          <IconButton
            variant="ghost"
            size="sm"
            icon={Pencil}
            aria-label={i18n.t('detectionIntelligence.peopleList.edit', 'Edit {{name}}', {
              name: identity.name,
            })}
            onClick={(event) => {
              event.stopPropagation()
              deps.onEdit(identity)
            }}
          />
          <IconButton
            variant="ghost"
            size="sm"
            icon={Trash2}
            aria-label={i18n.t('detectionIntelligence.peopleList.delete', 'Delete {{name}}', {
              name: identity.name,
            })}
            onClick={(event) => {
              event.stopPropagation()
              deps.onDelete(identity)
            }}
          />
        </span>
      ),
    },
  ]
}

// ── Person form dialog ─────────────────────────────────────────────────────────

interface PersonFormDialogProps {
  readonly mode: 'new' | 'edit'
  readonly identity: Identity | null
  readonly onClose: () => void
}

function PersonFormDialog({ mode, identity, onClose }: PersonFormDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState(mode === 'edit' ? (identity?.name ?? '') : '')
  const createIdentity = useFaceGalleryCreateIdentity()
  const renameIdentity = useFaceGalleryRenameIdentity()

  useEffect(() => {
    setName(mode === 'edit' ? (identity?.name ?? '') : '')
  }, [mode, identity?.id, identity?.name])

  const saving = createIdentity.isPending || renameIdentity.isPending
  const trimmed = name.trim()
  const nameUnchanged = mode === 'edit' && identity !== null && trimmed === identity.name
  const saveDisabled = saving || trimmed.length === 0 || nameUnchanged

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
  }

  function handleSave(): void {
    if (saveDisabled) return
    if (mode === 'new') {
      createIdentity.mutate(
        { name: trimmed },
        {
          onSuccess: () => {
            invalidate()
            onClose()
          },
        },
      )
      return
    }
    if (identity === null) {
      onClose()
      return
    }
    renameIdentity.mutate(
      { id: identity.id, name: trimmed },
      {
        onSuccess: () => {
          invalidate()
          onClose()
        },
      },
    )
  }

  const title = mode === 'new' ? 'Add person' : `Edit ${identity?.name ?? 'person'}`

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      title={title}
      icon={UserRound}
      width={mode === 'edit' ? 'xl' : 'lg'}
      testId="people-person-form"
      footer={
        <Button
          variant="primary"
          size="sm"
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {mode === 'new' ? t('common.add', 'Add') : t('common.save', 'Save')}
        </Button>
      }
    >
      <div className="space-y-4">
        <FormField label={t('detectionIntelligence.peopleList.name', 'Name')} required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
            placeholder={t('detectionIntelligence.peopleList.personName', 'Person name…')}
            autoFocus
          />
        </FormField>

        {mode === 'edit' && identity !== null && (
          <div>
            <p className="mb-1 text-[11px] font-medium text-foreground">
              {t('detectionIntelligence.peopleList.trainingSamples', 'Training samples')}
            </p>
            <p className="mb-2 text-[11px] text-foreground-subtle">
              {t(
                'detectionIntelligence.peopleList.removeASampleToDrop',
                'Remove a sample to drop it from recognition training for this person.',
              )}
            </p>
            <SamplesGrid identityId={identity.id} />
          </div>
        )}
      </div>
    </ItemFormDialog>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function PeopleList() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const { data: identities, isLoading } = useFaceGalleryListIdentities()
  const deleteIdentity = useFaceGalleryDeleteIdentity()
  const { state: formUrl, openNew, openEdit, close: closeForm } = useItemFormUrl()
  const [photoOpen, setPhotoOpen] = useState(false)

  const rows = identities ?? []
  const filter = useDataTableFilter(rows, {
    searchText: (identity) => [identity.name],
  })

  const editingIdentity =
    formUrl.mode === 'edit' ? (rows.find((identity) => identity.id === formUrl.id) ?? null) : null

  // A stale `?edit=` (person deleted elsewhere) must not leave the dialog open
  // on a missing row.
  useEffect(() => {
    if (formUrl.mode === 'edit' && !isLoading && editingIdentity === null) {
      closeForm()
    }
  }, [formUrl.mode, isLoading, editingIdentity, closeForm])

  const columns = useMemo(
    () =>
      peopleColumns({
        onEdit: (identity) => openEdit(identity.id),
        onDelete: (identity) => {
          void (async () => {
            const ok = await confirm({
              title: t('detectionIntelligence.peopleList.deletePerson', 'Delete person'),
              message: t(
                'detectionIntelligence.peopleList.deleteAndAllTheirSamples',
                'Delete {{name}} and all their samples? This cannot be undone.',
                { name: identity.name },
              ),
              confirmLabel: t('common.delete', 'Delete'),
              variant: 'danger',
            })
            if (!ok) return
            deleteIdentity.mutate(
              { id: identity.id },
              {
                onSettled: () => {
                  void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
                  if (formUrl.mode === 'edit' && formUrl.id === identity.id) closeForm()
                },
              },
            )
          })()
        },
      }),
    [confirm, closeForm, deleteIdentity, formUrl, openEdit, queryClient, t],
  )

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-foreground-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('detectionIntelligence.peopleList.loadingPeople', 'Loading people…')}
      </div>
    )
  }

  const formOpen = formUrl.mode === 'new' || (formUrl.mode === 'edit' && editingIdentity !== null)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" type="button" onClick={openNew}>
          <Plus className="h-3.5 w-3.5" />
          {t('detectionIntelligence.peopleList.addPerson', 'Add person')}
        </Button>
        {/* Enrolling from a PHOTO is the only path that stores a reloadable
            original beside the sample, which is what lets the gallery be
            re-embedded when the cluster's face model changes. */}
        <Button variant="secondary" size="sm" type="button" onClick={() => setPhotoOpen(true)}>
          <ImagePlus className="h-3.5 w-3.5" />
          {t('detectionIntelligence.peopleList.enrolFromAPhoto', 'Enrol from a photo')}
        </Button>
      </div>

      {(rows.length > 0 || filter.active) && (
        <DataTableFilterBar
          state={filter.state}
          facets={filter.facets}
          labels={{
            searchPlaceholder: 'Search people…',
            searchLabel: 'Search people',
            facetsLabel: 'Filter',
            clearLabel: 'Clear',
          }}
          onSearch={filter.setSearch}
          onToggleFacet={filter.toggleFacet}
          onClear={filter.clear}
        />
      )}

      {filter.rows.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title={
            filter.active
              ? t(
                  'detectionIntelligence.peopleList.nothingMatchesTheFilter',
                  'Nothing matches the filter',
                )
              : t('detectionIntelligence.peopleList.noPeopleEnrolledYet', 'No people enrolled yet')
          }
          description={
            filter.active
              ? t(
                  'detectionIntelligence.peopleList.clearTheSearchOrTry',
                  'Clear the search or try another name.',
                )
              : t(
                  'detectionIntelligence.peopleList.addAPersonOrEnrol',
                  'Add a person, or enrol faces from a photo.',
                )
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={filter.rows}
          rowKey={(identity) => identity.id}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={t(
            'detectionIntelligence.peopleList.noPeopleEnrolledYet2',
            'No people enrolled yet.',
          )}
          onRowClick={(identity) => openEdit(identity.id)}
        />
      )}

      {formOpen && (
        <PersonFormDialog
          mode={formUrl.mode === 'new' ? 'new' : 'edit'}
          identity={editingIdentity}
          onClose={closeForm}
        />
      )}

      <PhotoEnrollDialog open={photoOpen} onOpenChange={setPhotoOpen} />
    </div>
  )
}
