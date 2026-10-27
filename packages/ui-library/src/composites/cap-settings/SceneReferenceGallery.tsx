/**
 * SceneReferenceGallery — the photographs a scene is actually judging against,
 * grouped by lighting variant, each individually deletable.
 *
 * ## Why it has to exist
 *
 * A scene's whole answer is "does this region still look like the photograph".
 * Until now the operator could see a COUNT of references and never the
 * references themselves, which makes the two failure modes indistinguishable
 * from the outside: a blurry capture taken while a van was in the way poisons a
 * condition forever, and from a cosine score there is no way to tell which one
 * it was. `deleteReference` shipped with the cap for exactly this and had no
 * caller.
 *
 * ## The image
 *
 * A bare `<img>` against the `event-media` data plane
 * (`/addon/pipeline-analytics/event-media/m/<mediaId>` — D482), which is
 * `access: 'authenticated'` — that accepts the `camstack_session` cookie, and a
 * cookie is the only credential an `<img>` can send. Same mechanism, and the
 * same reasoning, as `use-device-snapshot`; no bearer-token blob fetch is
 * needed and no second copy of the auth plumbing is introduced here.
 *
 * `SceneReference.thumbnailMediaId` finally IS a media row id (D482). It was
 * named `…MediaId` while holding a composite MediaStore key
 * (`scene:<ownerId>:thumbnailSmall:<ts>`), which this component read
 * POSITIONALLY for its owner id — a name that described the right design
 * beside a value that did not, which is the shape of leftover this repo has
 * been bitten by three times. The tile now addresses the row.
 *
 * **A missing blob is normal, not exceptional.** Reference thumbnails written
 * before the `ownerKind: 'scene'` fix carried an `ownerId` no event row backs,
 * which made them eligible for the orphan sweep — so on an existing install
 * some of these ids resolve to nothing. That must degrade to a dated
 * placeholder: the reference is still real, still being scored against, and
 * still deletable. A gallery that blanks or throws over a missing picture would
 * take the delete button away exactly when it is needed.
 */

import { useUiText } from '../../contexts/ui-text'
import { useConfirm } from '../confirm-dialog'
import type { SceneMonitor, SceneReference } from '@camstack/types'
import { ImageOff, Trash2 } from 'lucide-react'
import { useState, type JSX } from 'react'
import { hubPath } from '../../lib/hub-mount'
import { TEXT_HINT } from '../../lib/responsive'
import { variantLabel } from './scene-monitor-copy'

/** The hub-proxied prefix for the pipeline-analytics event-media data plane. */
export const SCENE_MEDIA_BASE: string = hubPath('/addon/pipeline-analytics/event-media')

/**
 * The plane's ROW-form path for a scene reference thumbnail (D482).
 *
 * `thumbnailMediaId` is the media row's OWN id, so the tile addresses the row
 * and nothing else — no owner id to re-derive, and no key to parse. It used to
 * be a composite MediaStore key (`scene:<ownerId>:thumbnailSmall:<ts>`) that
 * this component read POSITIONALLY for its owner id; the field was already
 * named `…MediaId` while holding a key, which is the kind of leftover that
 * reads as done.
 */
function sceneMediaPath(mediaId: number): string {
  return `${SCENE_MEDIA_BASE}/m/${mediaId}`
}

/** One reference, with the coordinates `deleteReference` addresses it by. */
export interface SceneReferenceTile {
  readonly stateId: string
  /** Index into THAT state's `references` array — the cap's own addressing. */
  readonly index: number
  readonly reference: SceneReference
}

export interface SceneReferenceGroup {
  readonly condition: string
  readonly tiles: readonly SceneReferenceTile[]
}

/**
 * Flatten `states[].references[]` into per-condition groups while keeping each
 * reference's `(stateId, index)` — the pair `deleteReference` takes.
 *
 * The index is deliberately the position in the state's OWN array rather than
 * anything derived from the grouping: an index computed over the grouped view
 * would address a different reference the moment a scene holds two conditions,
 * and the operator would delete the wrong photograph with no way to tell.
 */
export function groupReferences(monitor: SceneMonitor): readonly SceneReferenceGroup[] {
  const byCondition = new Map<string, SceneReferenceTile[]>()
  for (const state of monitor.states) {
    state.references.forEach((reference, index) => {
      const list = byCondition.get(reference.condition) ?? []
      list.push({ stateId: state.id, index, reference })
      byCondition.set(reference.condition, list)
    })
  }
  return [...byCondition.entries()]
    .map(([condition, tiles]) => ({
      condition,
      tiles: [...tiles].sort((a, b) => b.reference.capturedAt - a.reference.capturedAt),
    }))
    .sort((a, b) => a.condition.localeCompare(b.condition))
}

/** Total references across every state — the count that decides whether a
 *  delete leaves the scene with no idea what "normal" looks like. */
export function totalReferences(monitor: SceneMonitor): number {
  return monitor.states.reduce((n, s) => n + s.references.length, 0)
}

export interface SceneReferenceGalleryProps {
  readonly monitor: SceneMonitor
  readonly disabled: boolean
  readonly onDelete: (input: { stateId: string; index: number }) => void
}

const BTN_TINY =
  'rounded border border-danger/50 bg-danger/10 px-1 py-0.5 text-[10px] font-medium text-danger hover:bg-danger/20 disabled:opacity-40 transition-colors'

export function SceneReferenceGallery({
  monitor,
  disabled,
  onDelete,
}: SceneReferenceGalleryProps): JSX.Element {
  const t = useUiText()
  const groups = groupReferences(monitor)
  const total = totalReferences(monitor)
  const confirm = useConfirm()

  if (groups.length === 0) {
    return (
      <p className={`${TEXT_HINT} leading-relaxed`}>
        {t(
          'uiLibrary.sceneReferenceGallery.empty',
          'No photographs captured yet. Press “Capture daylight” to take the one this scene will judge everything against.',
        )}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <div key={group.condition} className="flex flex-col gap-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">
            {variantLabel(group.condition, t)} · {group.tiles.length}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {group.tiles.map((tile) => {
              const key = `${tile.stateId}:${String(tile.index)}`
              // Deleting the last photograph of ONE variant is a legitimate,
              // ordinary act — it uncovers that light, and an uncovered light
              // is skipped, not broken (D164). Deleting the last one the scene
              // has ANYWHERE is different in kind: it leaves the scene with no
              // notion of normal and unable to judge at all, so it is confirmed
              // rather than done on a single click.
              const isLastOverall = total === 1
              return (
                <li
                  key={key}
                  className="flex w-24 flex-col gap-1 rounded-md border border-border p-1"
                >
                  <ReferenceThumb reference={tile.reference} />
                  <span className={`${TEXT_HINT} tabular-nums`}>
                    {formatCapturedAt(tile.reference.capturedAt)}
                  </span>
                  <button
                    type="button"
                    className={BTN_TINY}
                    disabled={disabled}
                    aria-label={t(
                      'uiLibrary.sceneReferenceGallery.deleteLabel',
                      'Delete the {{variant}} photograph from {{date}}',
                      {
                        variant: variantLabel(group.condition, t).toLowerCase(),
                        date: formatCapturedAt(tile.reference.capturedAt),
                      },
                    )}
                    onClick={() => {
                      void (async () => {
                        if (isLastOverall) {
                          const accepted = await confirm({
                            title: t(
                              'uiLibrary.sceneReferenceGallery.deleteTitle',
                              'Delete the only photograph?',
                            ),
                            message: t(
                              'uiLibrary.sceneReferenceGallery.lastWarning',
                              'This is the only photograph this scene has. Delete it and the scene no longer knows what normal looks like — it stops judging until you capture again.',
                            ),
                            confirmLabel: t('uiLibrary.sceneReferenceGallery.delete', 'Delete'),
                            variant: 'danger',
                          })
                          if (!accepted) return
                        }
                        onDelete({ stateId: tile.stateId, index: tile.index })
                      })()
                    }}
                  >
                    <Trash2 className="mr-1 inline h-3 w-3" />
                    {t('uiLibrary.sceneReferenceGallery.delete', 'Delete')}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

function ReferenceThumb({ reference }: { readonly reference: SceneReference }) {
  const t = useUiText()
  const [failed, setFailed] = useState(false)
  // A reference with no stored picture has NO media id — absent, never 0.
  // `/m/0` would be a request for a row that cannot exist, and the tile's job
  // when there is no picture is to say so, not to ask for one.
  const mediaId = reference.thumbnailMediaId
  if (mediaId === undefined || failed) {
    return (
      <div
        className="flex h-16 w-full flex-col items-center justify-center gap-0.5 rounded bg-surface text-foreground-subtle"
        title={t(
          'uiLibrary.sceneReferenceGallery.missingPicture',
          'The picture for this reference is no longer stored. The reference itself is intact and still being scored against.',
        )}
      >
        <ImageOff className="h-4 w-4" />
        <span className="text-[9px]">
          {t('uiLibrary.sceneReferenceGallery.noPicture', 'no picture')}
        </span>
      </div>
    )
  }
  return (
    <img
      src={sceneMediaPath(mediaId)}
      alt=""
      loading="lazy"
      className="h-16 w-full rounded object-cover"
      onError={() => setFailed(true)}
    />
  )
}

function formatCapturedAt(at: number): string {
  const d = new Date(at)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
