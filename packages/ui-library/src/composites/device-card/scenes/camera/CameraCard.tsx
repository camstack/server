import type { ReactElement, ReactNode } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import type { CameraChip } from '../../connected/camera-chips-model'
import { ValueChip } from '../../parts/ValueChip'
import { CardTop, useDeviceCardFrame } from '../../shell/DeviceCard'
import type { CardCommon } from '../../shell/model'

export interface CameraCardProps {
  readonly common: CardCommon
  /** State chips drawn over the top of the scene; only the facts the device knows. */
  readonly chips: readonly CameraChip[]
  /** The camera's live / snapshot view, owned by the host (the device page's player). */
  readonly scene: ReactNode
  /** The recorded series under the scene; null when the device records none. */
  readonly history: ReactNode
  readonly showName?: boolean
  readonly className?: string
}

/**
 * A camera: the state chips on top, the host's scene full width under them,
 * and the recorded history under that. The scene is the host's player with its
 * own toolbar, so chips sit in a row above it, never over it. It is not a
 * fixed-proportion scene, so it frames itself like the other cards instead of
 * filling the shell's grid.
 */
export function CameraCard({
  common,
  chips,
  scene,
  history,
  showName = true,
  className,
}: CameraCardProps): ReactElement {
  const t = useUiText()
  const bare = useDeviceCardFrame() === 'bare'
  return (
    <article
      data-testid="device-card"
      data-card-kind="camera"
      data-frame={bare ? 'bare' : 'card'}
      className={cn(
        'flex w-full flex-col gap-2.5 text-foreground',
        !bare && 'max-w-180 rounded-3xl border border-border bg-surface p-3.5',
        className,
      )}
    >
      {bare ? null : <CardTop common={common} />}
      {showName ? (
        <h3 className="text-xl font-semibold leading-tight" data-testid="dc-name">
          {common.name}
        </h3>
      ) : null}
      {chips.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5" data-testid="dc-camera-chips">
          {chips.map((chip) => (
            <ValueChip
              key={chip.id}
              glyph={chip.glyph}
              tone={chip.tone}
              data-testid={`dc-camera-chip-${chip.id}`}
            >
              {chip.label}
            </ValueChip>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-2xl" data-testid="dc-camera-scene">
        {scene}
      </div>
      {history === null ? null : (
        <section className="flex flex-col gap-2" data-testid="dc-camera-history">
          <h4 className="text-sm font-semibold text-foreground-muted">
            {t('uiLibrary.deviceCard.camera.history', 'History')}
          </h4>
          {history}
        </section>
      )}
    </article>
  )
}
