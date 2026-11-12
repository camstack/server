import { type ReactElement, useState } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import {
  CoverIllustration,
  type CoverIllustrationProps,
  SlatGlyph,
} from '../../illustrations/CoverIllustration'
import { ArmedButton } from '../../parts/ArmedButton'
import { CardButton } from '../../parts/CardButton'
import { HorizontalSlider } from '../../parts/sliders'
import { useCardGating } from '../../shell/gating'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import {
  type CoverCardActions,
  type CoverCardModel,
  type CoverRoleSpec,
  drawnValueOf,
  positionOf,
} from './model'

export interface CoverCardProps {
  readonly model: CoverCardModel
  readonly actions: CoverCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

type Translate = ReturnType<typeof useUiText>

/** How far a tilt button moves the slats. */
const TILT_STEP = 15

/** The state word, in the role's own sense and gender ("Closed 40%", "Extended", "Opening"). */
export function coverStateWord(
  t: Translate,
  spec: CoverRoleSpec,
  drawn: number,
  state: CoverCardModel['state'],
): string {
  if (state === 'opening') return t('uiLibrary.deviceCard.cover.opening', 'Opening')
  if (state === 'closing') return t('uiLibrary.deviceCard.cover.closing', 'Closing')
  const g = spec.gender
  if (spec.kind === 'extend') {
    if (drawn <= 0) return t('uiLibrary.deviceCard.cover.retracted', 'Retracted')
    if (drawn >= 100) return t('uiLibrary.deviceCard.cover.extended', 'Extended')
    return t('uiLibrary.deviceCard.cover.extendedBy', 'Extended {{pct}}%', { pct: drawn })
  }
  const open = t(`uiLibrary.deviceCard.cover.${g}.open`, 'Open')
  const closed = t(`uiLibrary.deviceCard.cover.${g}.closed`, 'Closed')
  if (spec.kind === 'open') {
    if (drawn <= 0) return closed
    if (drawn >= 100) return open
    return t(`uiLibrary.deviceCard.cover.${g}.openBy`, 'Open {{pct}}%', { pct: drawn })
  }
  if (drawn <= 0) return open
  if (drawn >= 100) return closed
  return t(`uiLibrary.deviceCard.cover.${g}.closedBy`, 'Closed {{pct}}%', { pct: drawn })
}

function sliderLabel(t: Translate, spec: CoverRoleSpec): string {
  if (spec.kind === 'extend') return t('uiLibrary.deviceCard.cover.extension', 'Extension')
  if (spec.kind === 'open') return t('uiLibrary.deviceCard.cover.openingLevel', 'Opening')
  return t('uiLibrary.deviceCard.cover.closure', 'Closure')
}

/** The three movement buttons of a cover that takes a position. */
function MoveButtons({
  model,
  actions,
}: {
  readonly model: CoverCardModel
  readonly actions: CoverCardActions
}): ReactElement {
  const t = useUiText()
  const { kind, drag } = model.spec
  const open = t('uiLibrary.deviceCard.cover.open', 'Open')
  const close = t('uiLibrary.deviceCard.cover.close', 'Close')
  const stop = model.stoppable ? (
    <CardButton
      glyph="stop"
      aria-label={t('uiLibrary.deviceCard.cover.stop', 'Stop')}
      data-testid="dc-cover-stop"
      onClick={actions.onStop}
    />
  ) : null
  if (kind === 'closure') {
    return (
      <>
        <CardButton
          glyph={drag === 'x' ? 'spread' : 'up'}
          aria-label={open}
          data-testid="dc-cover-open"
          onClick={actions.onOpen}
        />
        {stop}
        <CardButton
          glyph={drag === 'x' ? 'gather' : 'down'}
          aria-label={close}
          data-testid="dc-cover-close"
          onClick={actions.onClose}
        />
      </>
    )
  }
  const [first, second] =
    kind === 'extend'
      ? [
          t('uiLibrary.deviceCard.cover.retract', 'Retract'),
          t('uiLibrary.deviceCard.cover.extend', 'Extend'),
        ]
      : [close, open]
  return (
    <>
      <CardButton data-testid="dc-cover-close" onClick={actions.onClose}>
        {first}
      </CardButton>
      {stop}
      <CardButton data-testid="dc-cover-open" onClick={actions.onOpen}>
        {second}
      </CardButton>
    </>
  )
}

/** Open / Close for a cover with no position; a gate, a garage or a door asks twice. */
function MainButtons({
  model,
  actions,
  drawn,
}: {
  readonly model: CoverCardModel
  readonly actions: CoverCardActions
  readonly drawn: number
}): ReactElement {
  const t = useUiText()
  const shut = model.spec.kind === 'closure' ? drawn >= 50 : drawn < 50
  const label = shut
    ? t('uiLibrary.deviceCard.cover.open', 'Open')
    : t('uiLibrary.deviceCard.cover.close', 'Close')
  const run = shut ? actions.onOpen : actions.onClose
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {model.spec.secure ? (
        <ArmedButton
          glyph="lock"
          tone="primary"
          onConfirm={run}
          armedLabel={t('uiLibrary.deviceCard.cover.confirm', 'Tap again to confirm')}
          testId="dc-cover-main"
        >
          {label}
        </ArmedButton>
      ) : (
        <CardButton tone="primary" data-testid="dc-cover-main" onClick={run}>
          {label}
        </CardButton>
      )}
      {model.stoppable ? (
        <CardButton glyph="stop" data-testid="dc-cover-stop" onClick={actions.onStop}>
          {t('uiLibrary.deviceCard.cover.stop', 'Stop')}
        </CardButton>
      ) : null}
    </div>
  )
}

/** The slats: open and close a step, the value between them. */
function TiltButtons({
  tilt,
  onTilt,
}: {
  readonly tilt: number
  readonly onTilt: (tilt: number) => void
}): ReactElement {
  const t = useUiText()
  const openSlats = t('uiLibrary.deviceCard.cover.slatsOpen', 'Open slats')
  const closeSlats = t('uiLibrary.deviceCard.cover.slatsClose', 'Close slats')
  return (
    <>
      <CardButton
        aria-label={openSlats}
        title={openSlats}
        data-testid="dc-cover-slats-open"
        onClick={() => onTilt(Math.min(100, tilt + TILT_STEP))}
      >
        <SlatGlyph angle={0} />
      </CardButton>
      <span className="text-xs font-semibold tabular-nums text-foreground-muted">{tilt}%</span>
      <CardButton
        aria-label={closeSlats}
        title={closeSlats}
        data-testid="dc-cover-slats-close"
        onClick={() => onTilt(Math.max(0, tilt - TILT_STEP))}
      >
        <SlatGlyph angle={50} />
      </CardButton>
    </>
  )
}

/** The drawing, its grip still while the card is gated (read inside the card's gating). */
function GatedCoverIllustration(props: Omit<CoverIllustrationProps, 'interactive'>): ReactElement {
  const gating = useCardGating()
  return <CoverIllustration {...props} interactive={!gating.blocked} />
}

/**
 * The cover: drawn as its role (a shutter, an awning, a gate …) at its
 * position. One that takes a position moves with the arrows, the slider or by
 * dragging the drawing; one that does not opens and closes, and a gate, a
 * garage or a door asks for a second press.
 */
export function CoverCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: CoverCardProps): ReactElement {
  const t = useUiText()
  const [draft, setDraft] = useState<number | null>(null)
  const { spec } = model
  const reported = drawnValueOf(model)
  const drawn = draft ?? reported
  const word = coverStateWord(t, spec, drawn, model.state)
  const moving = model.state === 'opening' || model.state === 'closing'
  const fullyShut = spec.kind === 'closure' ? drawn >= 100 : drawn <= 0
  const tone: CardTone = moving ? 'primary' : fullyShut ? 'muted' : 'primary'
  const commit = (value: number): void => {
    setDraft(null)
    actions.onPosition(positionOf(spec.kind, value))
  }
  return (
    <DeviceCard
      kind="cover"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={moving ? 'moving' : fullyShut ? 'closed' : 'open'}
      state={{ label: word, since: model.since, tone }}
      scene={{
        left:
          model.positionable && model.tilt !== null ? (
            <TiltButtons tilt={model.tilt} onTilt={actions.onTilt} />
          ) : null,
        image: (
          <GatedCoverIllustration
            drawing={spec.drawing}
            value={drawn}
            drag={model.positionable ? spec.drag : 'none'}
            ariaLabel={word}
            gripLabel={t('uiLibrary.deviceCard.cover.drag', 'Drag')}
            onDrag={setDraft}
            onDragEnd={commit}
            className="h-44 w-30"
          />
        ),
        right: model.positionable ? <MoveButtons model={model} actions={actions} /> : null,
        bottom: model.positionable ? (
          <>
            <HorizontalSlider
              label={sliderLabel(t, spec)}
              value={drawn}
              min={0}
              max={100}
              ariaLabel={sliderLabel(t, spec)}
              valueLabel={(v) => `${v}%`}
              onChange={setDraft}
              onCommit={commit}
              testId="dc-cover-position"
            />
            {model.tilt === null ? null : (
              <HorizontalSlider
                label={t('uiLibrary.deviceCard.cover.slats', 'Slats')}
                value={model.tilt}
                min={0}
                max={100}
                ariaLabel={t('uiLibrary.deviceCard.cover.slats', 'Slats')}
                valueLabel={(v) => `${v}%`}
                onCommit={actions.onTilt}
                testId="dc-cover-tilt"
              />
            )}
          </>
        ) : (
          <MainButtons model={model} actions={actions} drawn={drawn} />
        ),
      }}
    />
  )
}
