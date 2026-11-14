import { type ReactElement, useState } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import {
  CoverIllustration,
  type CoverIllustrationProps,
  SlatGlyph,
} from '../../illustrations/CoverIllustration'
import { HorizontalSlider } from '../../parts/sliders'
import {
  type ColumnItem,
  columnArmedButton,
  columnButton,
  columnValue,
} from '../../shell/column-items'
import { useCardGating } from '../../shell/gating'
import { rowSlider } from '../../shell/bottom-rows'
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
    return t('uiLibrary.deviceCard.cover.extendedBy', 'Extended {{pct}}%', {
      pct: drawn,
    })
  }
  const open = t(`uiLibrary.deviceCard.cover.${g}.open`, 'Open')
  const closed = t(`uiLibrary.deviceCard.cover.${g}.closed`, 'Closed')
  if (spec.kind === 'open') {
    if (drawn <= 0) return closed
    if (drawn >= 100) return open
    return t(`uiLibrary.deviceCard.cover.${g}.openBy`, 'Open {{pct}}%', {
      pct: drawn,
    })
  }
  if (drawn <= 0) return open
  if (drawn >= 100) return closed
  return t(`uiLibrary.deviceCard.cover.${g}.closedBy`, 'Closed {{pct}}%', {
    pct: drawn,
  })
}

function sliderLabel(t: Translate, spec: CoverRoleSpec): string {
  if (spec.kind === 'extend') return t('uiLibrary.deviceCard.cover.extension', 'Extension')
  if (spec.kind === 'open') return t('uiLibrary.deviceCard.cover.openingLevel', 'Opening')
  return t('uiLibrary.deviceCard.cover.closure', 'Closure')
}

/** The movement buttons of a cover that takes a position: open, stop while it can, close. */
function moveItems(
  model: CoverCardModel,
  actions: CoverCardActions,
  t: Translate,
): readonly ColumnItem[] {
  const { kind, drag } = model.spec
  const open =
    kind === 'extend'
      ? t('uiLibrary.deviceCard.cover.extend', 'Extend')
      : t('uiLibrary.deviceCard.cover.open', 'Open')
  const close =
    kind === 'extend'
      ? t('uiLibrary.deviceCard.cover.retract', 'Retract')
      : t('uiLibrary.deviceCard.cover.close', 'Close')
  const opener = columnButton('open', {
    glyph: drag === 'x' ? 'spread' : 'up',
    label: open,
    testId: 'dc-cover-open',
    onPress: actions.onOpen,
  })
  const closer = columnButton('close', {
    glyph: drag === 'x' ? 'gather' : 'down',
    label: close,
    testId: 'dc-cover-close',
    onPress: actions.onClose,
  })
  const stop = model.stoppable
    ? [
        columnButton('stop', {
          glyph: 'stop',
          label: t('uiLibrary.deviceCard.cover.stop', 'Stop'),
          testId: 'dc-cover-stop',
          onPress: actions.onStop,
        }),
      ]
    : []
  return kind !== 'closure' ? [closer, ...stop, opener] : [opener, ...stop, closer]
}

/** Open / Close for a cover with no position; a gate, a garage or a door asks twice. */
function mainItems(
  model: CoverCardModel,
  actions: CoverCardActions,
  drawn: number,
  t: Translate,
): readonly ColumnItem[] {
  const shut = model.spec.kind === 'closure' ? drawn >= 50 : drawn < 50
  const label = shut
    ? t('uiLibrary.deviceCard.cover.open', 'Open')
    : t('uiLibrary.deviceCard.cover.close', 'Close')
  const run = shut ? actions.onOpen : actions.onClose
  const glyph = model.spec.drag === 'x' ? (shut ? 'spread' : 'gather') : shut ? 'up' : 'down'
  return [
    model.spec.secure
      ? columnArmedButton('main', {
          glyph: 'lock',
          tone: 'primary',
          label,
          caption: label,
          onConfirm: run,
          testId: 'dc-cover-main',
        })
      : columnButton('main', {
          glyph,
          tone: 'primary',
          label,
          testId: 'dc-cover-main',
          onPress: run,
        }),
    ...(model.stoppable
      ? [
          columnButton('stop', {
            glyph: 'stop',
            label: t('uiLibrary.deviceCard.cover.stop', 'Stop'),
            testId: 'dc-cover-stop',
            onPress: actions.onStop,
          }),
        ]
      : []),
  ]
}

/** The slats: open and close a step, the value between them. */
function tiltItems(
  tilt: number,
  onTilt: (tilt: number) => void,
  t: Translate,
): readonly ColumnItem[] {
  const openSlats = t('uiLibrary.deviceCard.cover.slatsOpen', 'Open slats')
  const closeSlats = t('uiLibrary.deviceCard.cover.slatsClose', 'Close slats')
  return [
    columnButton('slats-open', {
      face: <SlatGlyph angle={0} />,
      label: openSlats,
      testId: 'dc-cover-slats-open',
      onPress: () => onTilt(Math.min(100, tilt + TILT_STEP)),
    }),
    columnValue('slats-value', { value: `${tilt}%`, tone: 'muted' }),
    columnButton('slats-close', {
      face: <SlatGlyph angle={50} />,
      label: closeSlats,
      testId: 'dc-cover-slats-close',
      onPress: () => onTilt(Math.max(0, tilt - TILT_STEP)),
    }),
  ]
}

/** The drawing, its grip still while the card is gated (read inside the card's gating). */
function GatedCoverIllustration(props: Omit<CoverIllustrationProps, 'interactive'>): ReactElement {
  const gating = useCardGating()
  return <CoverIllustration {...props} interactive={!gating.blocked} />
}

/** A position the operator set, held until the device reports a different one. */
interface PositionDraft {
  readonly value: number
  /** The reported value the draft was made over; a new report replaces the draft. */
  readonly over: number
}

/**
 * The value under the operator's hand: shown while it travels, then held after
 * the command is sent — no snap back to the old report — until the device
 * reports a new position or the command fails.
 */
function usePositionDraft(reported: number): {
  readonly shown: number
  readonly move: (value: number) => void
  readonly hold: (value: number, sent: void | PromiseLike<boolean>) => void
} {
  const [draft, setDraft] = useState<PositionDraft | null>(null)
  const live = draft !== null && draft.over === reported ? draft : null
  return {
    shown: live?.value ?? reported,
    move: (value) => setDraft({ value, over: reported }),
    hold: (value, sent) => {
      const held: PositionDraft = { value, over: reported }
      setDraft(held)
      if (sent === undefined) return
      void Promise.resolve(sent).then((ok) => {
        if (!ok) setDraft((current) => (current === held ? null : current))
      })
    },
  }
}

/**
 * The cover: drawn as its role (a shutter, an awning, a gate …) at its
 * position. One that takes a position moves with the arrows, the slider or by
 * dragging the drawing; a gate, a garage or a door never does — it opens and
 * closes with a second press to confirm, its position (if reported) only in
 * the state word. Slats, when the cover has them, have their own buttons and
 * slider whether or not it takes a position.
 */
export function CoverCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: CoverCardProps): ReactElement {
  const t = useUiText()
  const { spec } = model
  const draft = usePositionDraft(drawnValueOf(model))
  const drawn = draft.shown
  const word = coverStateWord(t, spec, drawn, model.state)
  const moving = model.state === 'opening' || model.state === 'closing'
  const fullyShut = spec.kind === 'closure' ? drawn >= 100 : drawn <= 0
  const tone: CardTone = moving ? 'primary' : fullyShut ? 'muted' : 'primary'
  const positionable = model.positionable && !spec.secure
  const commit = (value: number): void => {
    draft.hold(value, actions.onPosition(positionOf(spec.kind, value)))
  }
  const tiltSlider =
    model.tilt === null ? null : (
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
    )
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
        columns: {
          left: model.tilt === null ? [] : tiltItems(model.tilt, actions.onTilt, t),
          right: positionable ? moveItems(model, actions, t) : mainItems(model, actions, drawn, t),
        },
        image: (
          <GatedCoverIllustration
            drawing={spec.drawing}
            value={drawn}
            drag={positionable ? spec.drag : 'none'}
            ariaLabel={word}
            gripLabel={t('uiLibrary.deviceCard.cover.drag', 'Drag')}
            onDrag={draft.move}
            onDragEnd={commit}
            className="h-auto w-full min-w-26 max-w-44"
          />
        ),
        bottom: [
          ...(positionable
            ? [
                rowSlider('position', {
                  slider: (
                    <HorizontalSlider
                      label={sliderLabel(t, spec)}
                      value={drawn}
                      min={0}
                      max={100}
                      ariaLabel={sliderLabel(t, spec)}
                      valueLabel={(v) => `${v}%`}
                      onChange={draft.move}
                      onCommit={commit}
                      testId="dc-cover-position"
                    />
                  ),
                }),
              ]
            : []),
          ...(tiltSlider === null ? [] : [rowSlider('tilt', { slider: tiltSlider })]),
        ],
      }}
    />
  )
}
