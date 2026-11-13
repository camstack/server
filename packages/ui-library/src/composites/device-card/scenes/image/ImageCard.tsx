import { type ReactElement, useEffect, useState } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { ImageDetailModal } from '../../../device-controls/image-control'
import { CardIcon } from '../../parts/CardIcon'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation } from '../../shell/model'

export interface ImageCardModel {
  readonly common: CardCommon
  /** The picture the browser loads; null when the source has none. */
  readonly url: string | null
  /** Since the picture last changed; null when unknown. */
  readonly updated: string | null
}

export interface ImageCardProps {
  readonly model: ImageCardModel
  readonly actions?: CardCommonActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/**
 * A still image (`image`): the picture itself, opened full size with zoom on
 * a click; a placeholder when there is none or it fails to load (an expired
 * link). It commands nothing.
 */
export function ImageCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: ImageCardProps): ReactElement {
  const t = useUiText()
  const [errored, setErrored] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => setErrored(false), [model.url])
  const url = errored ? null : model.url
  const alt =
    model.common.name === '' ? t('uiLibrary.imageControl.image', 'Image') : model.common.name
  return (
    <DeviceCard
      kind="image"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={url === null ? 'empty' : 'shown'}
      state={{
        label:
          url === null
            ? t('uiLibrary.imageControl.noImage', 'No image')
            : t('uiLibrary.deviceCard.image.shown', 'Image'),
        since:
          model.updated === null
            ? null
            : t('uiLibrary.deviceCard.image.updated', 'updated {{since}} ago', {
                since: model.updated,
              }),
        tone: url === null ? 'muted' : 'primary',
      }}
      scene={{
        image:
          url === null ? (
            <CardIcon glyph="image" className="h-20 w-20 text-foreground-subtle" />
          ) : (
            <>
              {/* ui-check-ok: the picture itself opens the zoom, as in ImageHeroCard; a Button variant would restyle it */}
              <button
                type="button"
                title={t('uiLibrary.imageControl.viewImage', 'View image')}
                data-testid="dc-image-open"
                onClick={() => setOpen(true)}
                className="flex w-full cursor-zoom-in items-center justify-center"
              >
                <img
                  src={url}
                  alt={alt}
                  onError={() => setErrored(true)}
                  className="max-h-48 w-full rounded-lg object-contain"
                />
              </button>
              <ImageDetailModal url={url} alt={alt} open={open} onOpenChange={setOpen} />
            </>
          ),
      }}
    />
  )
}
