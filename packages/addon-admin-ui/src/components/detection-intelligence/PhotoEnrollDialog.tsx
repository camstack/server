/**
 * PhotoEnrollDialog — enrol people from photographs.
 *
 * Upload one or MORE photos → the SERVER runs the pipeline's real face
 * detector and aligner over each one → every face comes back as the exact crop
 * the recognizer measured → the operator reviews ALL of them in one grid,
 * grouped by photo, assigns each face to a person (or ignores it) and confirms
 * once. The server contract stays per photo — one analysis, one session, one
 * enrol per face — the batch is purely this surface's review model
 * (`lib/photo-enroll-batch.ts`).
 *
 * Three things this surface must not do, each of which is a real failure this
 * repo has paid for:
 *
 *  - it must not enrol anything the operator did not name. A family photograph
 *    is several people and one of them may be a stranger;
 *  - it must not offer to enrol a face the SERVER refused. The refusal is
 *    shown with its reason instead, because "nothing happened" is how an
 *    operator concludes the feature is broken — the same goes for a photo with
 *    NO faces, and for a photo whose analysis failed: both are said, per photo;
 *  - it must not name a model. The stamp comes back from the run and is shown,
 *    never chosen here — on the day the cluster row is flipped this dialog is
 *    what proves the new samples landed in the new space.
 *
 * ENGLISH, hardcoded, deliberately. Every component under
 * `components/detection-intelligence/` except `EventKindFilter` is, exactly as
 * `components/pipeline/` is: localising one new dialog would make the surface
 * look half-translated, which is worse than consistently untranslated.
 */

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  useFaceGalleryCreateIdentity,
  useFaceGalleryListIdentities,
  useSystem,
  FileInput,
  Input,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ImagePlus, Loader2, RotateCw, UserRound } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  MAX_PHOTO_BYTES,
  PHOTO_ADDON_ID,
  PHOTO_ANALYZE_ACTION,
  PHOTO_DISCARD_ACTION,
  PHOTO_ENROLL_ACTION,
  type PhotoAnalyzeView,
  type PhotoEnrollRequest,
  type PhotoEnrollView,
  type PhotoFaceView,
  parsePhotoAnalyze,
  parsePhotoEnroll,
  refusalLabel,
} from '../../lib/photo-enroll'
import {
  ANALYZE_CONCURRENCY,
  type BatchAssignmentDraft,
  type BatchNewNames,
  type BatchPhoto,
  countBatchAssignable,
  enrollAssignedFaces,
  faceKey,
  mapWithConcurrency,
  MAX_PHOTOS_PER_BATCH,
  NEW_IDENTITY_SENTINEL,
  partitionPickedFiles,
  patchBatchPhoto,
  planNewIdentities,
  resolveNewIdentityAssignments,
  setBatchAssignment,
} from '../../lib/photo-enroll-batch'
import { Trans, useTranslation } from 'react-i18next'

const FACE_GALLERY_KEY = [['faceGallery']]

/** The sentinel a `<select>` uses for "do not enrol this face". */
const IGNORE = ''

interface PhotoEnrollDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

interface IdentityOption {
  readonly id: string
  readonly name: string
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('error', () => reject(new Error('the file could not be read')), {
      once: true,
    })
    reader.addEventListener(
      'load',
      () => {
        const result = reader.result
        if (typeof result !== 'string') {
          reject(new Error('the file could not be read'))
          return
        }
        // `data:image/jpeg;base64,XXXX` → `XXXX`
        const comma = result.indexOf(',')
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      },
      { once: true },
    )
    reader.readAsDataURL(file)
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── One face card ───────────────────────────────────────────────────────────

interface FaceCardProps {
  readonly face: PhotoFaceView
  readonly identities: readonly IdentityOption[]
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled: boolean
}

function FaceCard({ face, identities, value, onChange, disabled }: FaceCardProps) {
  const { t } = useTranslation()
  const options = useMemo(
    () => [
      {
        value: IGNORE,
        label: t('detectionIntelligence.photoEnrollDialog.ignoreThisFace', 'Ignore this face'),
      },
      ...identities.map((i) => ({ value: i.id, label: i.name })),
      {
        value: NEW_IDENTITY_SENTINEL,
        label: t('detectionIntelligence.photoEnrollDialog.newPerson', '+ New person…'),
      },
    ],
    [identities, t],
  )

  return (
    <div className="rounded-md border border-border bg-surface p-2">
      <div className="mb-2 aspect-square w-full overflow-hidden rounded border border-border bg-surface-hover">
        {face.alignedCropBase64 ? (
          <img
            src={`data:image/jpeg;base64,${face.alignedCropBase64}`}
            alt={t('detectionIntelligence.photoEnrollDialog.face', 'Face {{value1}}', {
              value1: face.faceIndex + 1,
            })}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-foreground-subtle">
            <UserRound className="h-8 w-8" />
          </div>
        )}
      </div>

      <div className="min-h-[4.75rem]">
        {face.enrollable ? (
          <>
            <Select
              options={options}
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              aria-label={t(
                'detectionIntelligence.photoEnrollDialog.assignFace',
                'Assign face {{value1}}',
                { value1: face.faceIndex + 1 },
              )}
            />
            <p className="mt-1 text-[10px] text-foreground-subtle">
              {Math.round(face.quality.detectionShortSidePx)} px
              {face.modelId ? ` · ${face.modelId}` : ''}
            </p>
          </>
        ) : (
          <div className="space-y-1">
            <Badge variant="warning" className="text-[10px]">
              {t('detectionIntelligence.photoEnrollDialog.notUsable', 'Not usable')}
            </Badge>
            {/* The reason, not just the refusal: "nothing happened" is how an
                operator concludes the feature is broken. */}
            <p className="text-[10px] leading-tight text-foreground-subtle">
              {refusalLabel(face.refusedReason)}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── One photo's section of the review ───────────────────────────────────────

interface PhotoSectionProps {
  readonly photo: BatchPhoto
  readonly identities: readonly IdentityOption[]
  readonly draft: BatchAssignmentDraft
  readonly newNames: BatchNewNames
  readonly disabled: boolean
  readonly onAssign: (faceIndex: number, value: string) => void
  readonly onNameChange: (faceIndex: number, name: string) => void
  readonly onRetry: () => void
}

function PhotoSection({
  photo,
  identities,
  draft,
  newNames,
  disabled,
  onAssign,
  onNameChange,
  onRetry,
}: PhotoSectionProps) {
  const { t } = useTranslation()
  const faces = photo.analysis?.faces ?? []
  const photoDraft = draft[photo.photoIndex] ?? {}

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 border-b border-border pb-1">
        <span className="truncate text-xs font-medium text-foreground">{photo.filename}</span>
        {photo.status === 'analyzing' || photo.status === 'queued' ? (
          <span className="flex items-center gap-1 text-xs text-foreground-subtle">
            <Loader2 className="h-3 w-3 animate-spin" />{' '}
            {t('detectionIntelligence.photoEnrollDialog.analysing')}
          </span>
        ) : null}
        {photo.status === 'analyzed' && photo.analysis !== undefined && (
          <span className="text-xs text-foreground-subtle">
            {t('detectionIntelligence.photoEnrollDialog.facesAnalysedOn', {
              count: faces.length,
              node: photo.analysis.ranOnNodeId,
            })}
          </span>
        )}
        {photo.status === 'failed' && (
          <Button variant="secondary" size="sm" disabled={disabled} onClick={onRetry}>
            <RotateCw className="h-3 w-3" /> {t('common.retry')}
          </Button>
        )}
      </div>

      {photo.status === 'failed' && (
        <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t(
              'detectionIntelligence.photoEnrollDialog.thisPhotoCouldNotBe',
              'This photo could not be analysed:',
            )}{' '}
            {photo.error ??
              t('detectionIntelligence.photoEnrollDialog.unknownError', 'unknown error')}
            . The other photos are unaffected.
          </span>
        </div>
      )}

      {photo.status === 'analyzed' && faces.length === 0 && (
        <p className="text-xs text-foreground-subtle">
          {t(
            'detectionIntelligence.photoEnrollDialog.noFacesWereFoundIn',
            'No faces were found in this photo. A face has to be reasonably large and facing the camera for the detector to measure it.',
          )}
        </p>
      )}

      {faces.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,7rem))] justify-start gap-3">
          {faces.map((face) => (
            <FaceCard
              key={face.faceIndex}
              face={face}
              identities={identities}
              value={photoDraft[face.faceIndex] ?? IGNORE}
              disabled={disabled}
              onChange={(value) => onAssign(face.faceIndex, value)}
            />
          ))}
        </div>
      )}

      {/* The name fields for every face of THIS photo set to "+ New person…".
          Kept out of the card so a 5-across grid does not become unreadable. */}
      {faces
        .filter((f) => photoDraft[f.faceIndex] === NEW_IDENTITY_SENTINEL)
        .map((f) => (
          <div key={f.faceIndex} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-xs text-foreground-subtle">
              {t('detectionIntelligence.photoEnrollDialog.faceN', { n: f.faceIndex + 1 })}
            </span>
            <Input
              className="h-7 flex-1 rounded-md border border-border bg-surface px-2.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={t(
                'detectionIntelligence.photoEnrollDialog.newPersonNameTypeThe',
                'New person name… (type the same name under another face to reuse it)',
              )}
              value={newNames[faceKey(photo.photoIndex, f.faceIndex)] ?? ''}
              onChange={(e) => onNameChange(f.faceIndex, e.target.value)}
            />
          </div>
        ))}
    </div>
  )
}

// ── Dialog ──────────────────────────────────────────────────────────────────

export function PhotoEnrollDialog({ open, onOpenChange }: PhotoEnrollDialogProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: identities } = useFaceGalleryListIdentities()
  const createIdentity = useFaceGalleryCreateIdentity()

  const [photos, setPhotos] = useState<readonly BatchPhoto[]>([])
  const [enrolling, setEnrolling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BatchAssignmentDraft>({})
  const [newNames, setNewNames] = useState<BatchNewNames>({})
  const [done, setDone] = useState<string | null>(null)

  const identityOptions: readonly IdentityOption[] = useMemo(
    () => (identities ?? []).map((i) => ({ id: i.id, name: i.name })),
    [identities],
  )

  const analyzing = photos.some((p) => p.status === 'queued' || p.status === 'analyzing')
  const busy = analyzing || enrolling

  /** Release every held session server-side. Best effort: the TTL is the
   *  backstop, so a failed discard costs nothing. */
  const discardSessions = useCallback(
    (batch: readonly BatchPhoto[]) => {
      for (const photo of batch) {
        const sessionId = photo.analysis?.sessionId
        if (sessionId === undefined) continue
        void system.trpcClient.addons.custom
          .mutate({
            addonId: PHOTO_ADDON_ID,
            action: PHOTO_DISCARD_ACTION,
            input: { sessionId },
          })
          .catch(() => undefined)
      }
    },
    [system],
  )

  const reset = useCallback(() => {
    setPhotos([])
    setDraft({})
    setNewNames({})
    setError(null)
    setDone(null)
    if (fileRef.current) fileRef.current.value = ''
  }, [])

  const close = useCallback(() => {
    discardSessions(photos)
    reset()
    onOpenChange(false)
  }, [discardSessions, onOpenChange, photos, reset])

  /** Run `photo.analyze` for ONE photo of the batch. Throws on failure. */
  const analyzePhoto = useCallback(
    async (photo: BatchPhoto): Promise<PhotoAnalyzeView> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: PHOTO_ADDON_ID,
        action: PHOTO_ANALYZE_ACTION,
        input: { photoBase64: photo.photoBase64, filename: photo.filename },
      })
      const parsed = parsePhotoAnalyze(raw)
      if (parsed === null) {
        throw new Error('the server replied with something this page could not read')
      }
      return parsed
    },
    [system],
  )

  /** Analyse one photo and fold the outcome into the batch state. */
  const runAnalysis = useCallback(
    async (photo: BatchPhoto): Promise<void> => {
      setPhotos((prev) =>
        patchBatchPhoto(prev, photo.photoIndex, {
          status: 'analyzing',
          error: undefined,
        }),
      )
      try {
        const analysis = await analyzePhoto(photo)
        setPhotos((prev) =>
          patchBatchPhoto(prev, photo.photoIndex, {
            status: 'analyzed',
            analysis,
          }),
        )
      } catch (err: unknown) {
        // One failed photo must not sink the batch — it is reported on its own
        // section, with a retry that re-analyses only it.
        setPhotos((prev) =>
          patchBatchPhoto(prev, photo.photoIndex, {
            status: 'failed',
            error: errorMessage(err),
          }),
        )
      }
    },
    [analyzePhoto],
  )

  const onPick = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return
      discardSessions(photos)
      reset()

      const pick = partitionPickedFiles(files, {
        maxCount: MAX_PHOTOS_PER_BATCH,
        maxBytes: MAX_PHOTO_BYTES,
      })
      const notices: string[] = []
      if (pick.oversize.length > 0) {
        notices.push(
          `Over the ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB limit and skipped: ${pick.oversize.join(', ')}.`,
        )
      }
      if (pick.overflow.length > 0) {
        notices.push(
          `A batch holds at most ${MAX_PHOTOS_PER_BATCH} photos — not analysed: ${pick.overflow.join(', ')}. Enrol them in a second round.`,
        )
      }
      if (notices.length > 0) setError(notices.join(' '))

      let batch: BatchPhoto[]
      try {
        batch = await Promise.all(
          pick.accepted.map(
            async (file, index): Promise<BatchPhoto> => ({
              photoIndex: index,
              filename: file.name,
              photoBase64: await readFileAsBase64(file),
              status: 'queued',
            }),
          ),
        )
      } catch (err: unknown) {
        setError(errorMessage(err))
        return
      }
      setPhotos(batch)
      // A few at a time: every analysis is a full pipeline run on a node.
      await mapWithConcurrency(batch, ANALYZE_CONCURRENCY, (photo) => runAnalysis(photo))
    },
    [discardSessions, photos, reset, runAnalysis],
  )

  const assignable = countBatchAssignable(photos, draft)

  const confirm = useCallback(async () => {
    setEnrolling(true)
    setError(null)
    setDone(null)
    try {
      // Resolve every "+ New person…" FIRST, one identity per unique name —
      // so a half-finished run cannot leave identities created with no samples
      // on them, and the same name under two faces stays ONE person.
      const plan = planNewIdentities(photos, draft, newNames)
      if (plan.kind === 'error') {
        setError(plan.message)
        return
      }
      const nameToId: Record<string, string> = {}
      for (const name of plan.names) {
        // The identity registry has ONE authority and it is this cap method —
        // the photo bridge deliberately cannot create people.
        const identity = await createIdentity.mutateAsync({ name })
        nameToId[name] = identity.id
      }
      const resolved = resolveNewIdentityAssignments(draft, newNames, nameToId)

      const enroll = async (request: PhotoEnrollRequest): Promise<PhotoEnrollView> => {
        const raw = await system.trpcClient.addons.custom.mutate({
          addonId: PHOTO_ADDON_ID,
          action: PHOTO_ENROLL_ACTION,
          input: request,
        })
        const parsed = parsePhotoEnroll(raw)
        if (parsed === null) throw new Error('unreadable reply')
        return parsed
      }

      const outcome = await enrollAssignedFaces(photos, resolved, {
        enroll,
        // An expired session is healed by re-analysing THAT photo — the bytes
        // are still held here, the operator re-picks nothing.
        reanalyze: (photo) => analyzePhoto(photo),
      })

      // Fold retry-minted analyses back in, so the review stays 1:1 with the
      // sessions the server actually holds.
      if (Object.keys(outcome.refreshedAnalyses).length > 0) {
        setPhotos((prev) =>
          prev.map((p) => {
            const fresh = outcome.refreshedAnalyses[p.photoIndex]
            return fresh === undefined ? p : { ...p, status: 'analyzed', analysis: fresh }
          }),
        )
      }

      void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
      if (outcome.failures.length > 0) setError(outcome.failures.join(' · '))
      setDone(
        outcome.enrolled === 0
          ? 'Nothing was enrolled.'
          : `Enrolled ${outcome.enrolled} sample${outcome.enrolled === 1 ? '' : 's'}${
              outcome.stampedModelId === null ? '' : ` with ${outcome.stampedModelId}`
            }.`,
      )
    } catch (err: unknown) {
      setError(errorMessage(err))
    } finally {
      setEnrolling(false)
    }
  }, [analyzePhoto, createIdentity, draft, newNames, photos, queryClient, system])

  const analyzedCount = photos.filter((p) => p.status === 'analyzed').length

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t('detectionIntelligence.photoEnrollDialog.enrolFromPhotos', 'Enrol from photos')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'detectionIntelligence.photoEnrollDialog.everyPhotoIsAnalysedWith',
              'Every photo is analysed with the same face detector the cameras use, and all the faces found are reviewed below in one pass, grouped by photo. Assign each face to a person, or leave it ignored.',
            )}
          </DialogDescription>
        </DialogHeader>

        {/* The recommendation is here rather than in the docs because this is
            the moment it is actionable. Samples from one burst look like one
            sample to the matcher. */}
        <div className="rounded-md border border-border bg-surface-hover px-3 py-2 text-xs text-foreground-subtle">
          <Trans
            i18nKey="detectionIntelligence.photoEnrollDialog.reliableRecognition"
            components={{ strong: <strong /> }}
          />
        </div>

        <div className="flex items-center gap-2">
          <FileInput
            ref={fileRef}
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={(e) => void onPick(Array.from(e.target.files ?? []))}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {analyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImagePlus className="h-3.5 w-3.5" />
            )}
            {t('detectionIntelligence.photoEnrollDialog.choosePhotos', 'Choose photos')}
          </Button>
          {photos.length > 0 && (
            <span className="text-xs text-foreground-subtle">
              {t('detectionIntelligence.photoEnrollDialog.photosAnalysed', {
                done: analyzedCount,
                count: photos.length,
              })}
            </span>
          )}
        </div>

        <div className="min-h-11" aria-live="polite">
          {error !== null ? (
            <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : done !== null ? (
            <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
              {done}
            </div>
          ) : null}
        </div>

        {photos.length > 0 && (
          <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-1">
            {photos.map((photo) => (
              <PhotoSection
                key={photo.photoIndex}
                photo={photo}
                identities={identityOptions}
                draft={draft}
                newNames={newNames}
                disabled={busy}
                onAssign={(faceIndex, value) =>
                  setDraft((prev) =>
                    setBatchAssignment(
                      prev,
                      photo.photoIndex,
                      faceIndex,
                      value === IGNORE ? null : value,
                    ),
                  )
                }
                onNameChange={(faceIndex, name) =>
                  setNewNames((prev) => ({
                    ...prev,
                    [faceKey(photo.photoIndex, faceIndex)]: name,
                  }))
                }
                onRetry={() => void runAnalysis(photo)}
              />
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={close} disabled={enrolling}>
            {t('common.close', 'Close')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void confirm()}
            disabled={busy || assignable === 0}
          >
            {enrolling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('detectionIntelligence.photoEnrollDialog.enrolFaces', { count: assignable })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
