import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaFixtures } from '../__fixtures__/media'
import { CLIMATE_FIXTURES } from '../__fixtures__/climate'
import { readOnly } from '../__fixtures__/common'
import { ClimateCard } from '../scenes/climate/ClimateCard'
import { MediaPlayerCard } from '../scenes/media/MediaPlayerCard'
import type { MediaCardActions, MediaCardModel } from '../scenes/media/model'
import { ColumnItem, columnButton } from '../shell/column-items'
import { SCENE_COLUMN_PCT, SCENE_MIN_PCT } from '../shell/scene-layout'
import { SceneGrid } from '../shell/SceneGrid'
import { DEVICE_CARD_CSS } from '../card-css'

afterEach(cleanup)

function mediaActions(): MediaCardActions {
  return {
    onPower: vi.fn(),
    onVolumeUp: vi.fn(),
    onVolumeDown: vi.fn(),
    onVolume: vi.fn(),
    onMute: vi.fn(),
    onSource: vi.fn(),
    onSeek: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onStop: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onShuffle: vi.fn(),
    onRepeat: vi.fn(),
  }
}

function mediaModel(id: string): MediaCardModel {
  const found = mediaFixtures().find((f) => f.id === id)
  if (found === undefined) throw new Error(`no fixture ${id}`)
  return found.model
}

/** A media player whose only control is power. */
function powerOnlyModel(): MediaCardModel {
  return {
    ...mediaModel('media-tv'),
    volume: null,
    sources: [],
    source: null,
    seek: null,
    transport: null,
    playback: null,
    power: { on: false },
    phase: 'off',
  }
}

describe('the scene proportions', () => {
  it('two equal columns of 15% leave the drawing at least 70%', () => {
    expect(SCENE_COLUMN_PCT).toBe(15)
    expect(SCENE_MIN_PCT).toBeGreaterThanOrEqual(70)
    expect(DEVICE_CARD_CSS).toContain(
      `grid-template-columns:${SCENE_COLUMN_PCT}% minmax(0,1fr) ${SCENE_COLUMN_PCT}%`,
    )
  })

  it('a fixed scene is marked fixed and a column-less one gives the drawing the whole width', () => {
    render(<SceneGrid image={<i />} columns={{}} corners={null} bottomCorners={false} />)
    const scene = screen.getByTestId('dc-scene')
    expect(scene.getAttribute('data-columns')).toBe('fixed')
    expect(scene.getAttribute('data-sides')).toBe('0')
  })

  it('one filled column still reserves the other, so the two stay equal', () => {
    const only = columnButton('a', { glyph: 'plus', label: 'More', onPress: vi.fn() })
    const { container } = render(
      <SceneGrid
        image={<i />}
        columns={{ left: [only] }}
        corners={null}
        bottomCorners={false}
      />,
    )
    expect(container.querySelector('[data-zone="left"]')).not.toBeNull()
    expect(container.querySelector('[data-zone="right"]')).not.toBeNull()
  })
})

describe('what a side column accepts', () => {
  it('refuses a node, a selector or a hand-built item at compile time', () => {
    const picker = <select aria-label="Mode" />
    // Never called: the lines below are checked by the compiler, which must refuse each.
    const refused = (): void => {
      render(
        <SceneGrid
          image={<i />}
          // @ts-expect-error a column takes ColumnItem[], never a ReactNode
          columns={{ left: picker }}
          corners={null}
          bottomCorners={false}
        />,
      )
      // @ts-expect-error a ColumnItem is built by the column factories only
      new ColumnItem('x', picker)
    }
    expect(refused).toBeTypeOf('function')
  })

  it('climate: the mode selector is in the bottom area, never in a column', () => {
    const f = CLIMATE_FIXTURES.find((c) => c.model.mode !== null && c.model.target !== null)
    if (f === undefined) throw new Error('no climate fixture with a mode')
    const { container } = render(
      <ClimateCard model={f.model} actions={{ ...climateNoops() }} orientation={f.orientation} />,
    )
    const mode = screen.getByTestId('dc-climate-mode')
    expect(container.querySelector('[data-zone="bottom"]')?.contains(mode)).toBe(true)
    for (const zone of ['left', 'right']) {
      expect(container.querySelector(`[data-zone="${zone}"]`)?.contains(mode) ?? false).toBe(false)
    }
  })

  it('media: the source picker is in the bottom area, the volume in the left column', () => {
    const { container } = render(
      <MediaPlayerCard model={mediaModel('media-tv')} actions={mediaActions()} />,
    )
    const source = screen.getByTestId('dc-media-source')
    expect(container.querySelector('[data-zone="bottom"]')?.contains(source)).toBe(true)
    expect(container.querySelector('[data-zone="right"]')?.contains(source) ?? false).toBe(false)
    expect(
      container.querySelector('[data-zone="left"]')?.contains(screen.getByTestId('dc-media-volume')),
    ).toBe(true)
  })
})

describe('power on the scene', () => {
  it('a power-only player is a switch on the drawing: a tap toggles, no power button beside it', () => {
    const actions = mediaActions()
    const { container } = render(<MediaPlayerCard model={powerOnlyModel()} actions={actions} />)
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBeTruthy()
    expect(container.querySelector('[data-zone="right"]')).toBeNull()
    expect(within(container).queryAllByRole('button', { name: /turn o/i })).toHaveLength(0)
    fireEvent.click(toggle)
    expect(actions.onPower).toHaveBeenCalledWith(true)
  })

  it('the keyboard toggles it with Enter and Space', () => {
    const actions = mediaActions()
    render(<MediaPlayerCard model={powerOnlyModel()} actions={actions} />)
    const toggle = screen.getByRole('switch')
    fireEvent.keyDown(toggle, { key: 'Enter' })
    fireEvent.keyDown(toggle, { key: ' ' })
    expect(actions.onPower).toHaveBeenCalledTimes(2)
  })

  it('a read-only card does not answer the tap and says why in the title', () => {
    const actions = mediaActions()
    const model = powerOnlyModel()
    render(
      <MediaPlayerCard
        model={{ ...model, common: readOnly(model.common) }}
        actions={actions}
      />,
    )
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)
    fireEvent.keyDown(toggle, { key: 'Enter' })
    expect(actions.onPower).not.toHaveBeenCalled()
    expect(toggle.getAttribute('aria-disabled')).toBe('true')
    expect(toggle.getAttribute('title')).toMatch(/read only/i)
  })

  it('a player with other controls keeps power as a column button, not on the scene', () => {
    render(<MediaPlayerCard model={mediaModel('media-tv')} actions={mediaActions()} />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByTestId('dc-media-power')).toBeTruthy()
  })
})

function climateNoops(): Parameters<typeof ClimateCard>[0]['actions'] {
  return {
    onPower: vi.fn(),
    onTarget: vi.fn(),
    onRange: vi.fn(),
    onMode: vi.fn(),
    onFan: vi.fn(),
    onPreset: vi.fn(),
    onHeatCool: vi.fn(),
    onSwing: vi.fn(),
    onSwingHorizontal: vi.fn(),
  }
}
