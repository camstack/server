import { type ReactElement, type ReactNode, useRef, useState } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import type { CameraChip } from '../../connected/camera-chips-model'
import { ValueChip } from '../../parts/ValueChip'
import { CardButton } from '../../parts/CardButton'
import { CardTop, useDeviceCardFill, useDeviceCardFrame } from '../../shell/DeviceCard'
import type { CardCommon, CardHistory } from '../../shell/model'
import { HistoryView } from '../../shell/Overlays'
import { OverlayBoxProvider } from '../../shell/overlay-box'

export interface CameraCardProps {
  readonly common: CardCommon
  /** State chips drawn over the top of the scene; only the facts the device knows. */
  readonly chips: readonly CameraChip[]
  /** The camera's live / snapshot view, owned by the host (the device page's player). */
  readonly scene: ReactNode
  /** The recorded series the History view shows; null when the device records none. */
  readonly history: CardHistory | null
  readonly showName?: boolean
  readonly className?: string
}

/**
 * A camera: the state chips on top and the host's scene full width under
 * them. The recorded history is the base card's History view: it replaces the
 * scene in a box of the scene's height (or the host's, when it sized the card),
 * so a long chart list scrolls inside the card and never grows the page. The
 * scene is the host's player with its own toolbar, so chips sit in a row above
 * it, never over it.
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
  const fill = useDeviceCardFill()
  const [historyOpen, setHistoryOpen] = useState(false)
  const sceneRef = useRef<HTMLDivElement>(null)
  const [sceneHeight, setSceneHeight] = useState<number | null>(null)
  const openHistory = (): void => {
    const measured = sceneRef.current?.getBoundingClientRect().height ?? 0
    if (measured > 0) setSceneHeight(measured)
    setHistoryOpen(true)
  }
  const showHistory = historyOpen && history !== null
  return (
    <article
      data-testid="device-card"
      data-card-kind="camera"
      data-view={showHistory ? 'history' : 'scene'}
      data-frame={bare ? 'bare' : 'card'}
      className={cn(
        'flex w-full flex-col gap-2.5 text-foreground',
        fill && 'h-full min-h-0',
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
      {showHistory ? (
        <OverlayBoxProvider value={{ fill, height: sceneHeight }}>
          <HistoryView
            state={{
              label: t('uiLibrary.deviceCard.camera.history', 'History'),
              since: null,
              tone: 'muted',
            }}
            history={history}
            onBack={() => setHistoryOpen(false)}
            {...(common.deviceId === undefined ? {} : { deviceId: common.deviceId })}
          />
        </OverlayBoxProvider>
      ) : (
        <>
          {chips.length === 0 && history === null ? null : (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="dc-camera-chips">
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
              {history === null ? null : (
                <CardButton
                  glyph="open"
                  actuates={false}
                  onClick={openHistory}
                  data-testid="dc-camera-open-history"
                  className="ml-auto min-h-8 px-2 py-1"
                >
                  {t('uiLibrary.deviceCard.camera.history', 'History')}
                </CardButton>
              )}
            </div>
          )}
          <div ref={sceneRef} className="overflow-hidden rounded-2xl" data-testid="dc-camera-scene">
            {scene}
          </div>
        </>
      )}
    </article>
  )
}
