// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRow } from '../device-row'
import { HeroCardA } from '../hero-card-a'
import { HERO_SCENE_ICON, HeroScene } from '../hero-scene'
import { resolveSceneVisual } from '../scene-map'
import { HERO_SCENE_IDS } from '../types'

afterEach(cleanup)

describe('scene selection', () => {
  it('every scene id renders a scene with a backdrop and an icon', () => {
    for (const scene of HERO_SCENE_IDS) {
      const { container, unmount } = render(<HeroScene scene={scene} state="on" />)
      expect(container.querySelector(`[data-scene="${scene}"]`)).not.toBeNull()
      expect(container.querySelector('[data-backdrop]')).not.toBeNull()
      expect(HERO_SCENE_ICON[scene]).toBeDefined()
      unmount()
    }
  })

  it.each([
    ['ac', 'cool', 'airflow', 'info'],
    ['ac', 'heat', 'airflow', 'warning'],
    ['ac', 'fan', 'airflow', 'muted'],
    ['ac', 'off', 'airflow', 'subtle'],
    ['washer', 'run', 'drum', 'warning'],
    ['washer', 'off', 'none', 'subtle'],
    ['dishwasher', 'run', 'drop', 'info'],
    ['pet-fountain', 'on', 'ripple', 'info'],
    ['vacuum', 'cleaning', 'sweep', 'primary'],
    ['vacuum', 'charging', 'breathe', 'success'],
    ['speaker', 'playing', 'bars', 'primary'],
    ['speaker', 'paused', 'none', 'subtle'],
    ['cover', 'closing', 'slats', 'info'],
    ['lock', 'locked', 'ring', 'success'],
    ['alarm', 'triggered', 'ripple', 'danger'],
    ['sensor-sparkline', '', 'spark', 'info'],
    ['event-stream', 'on', 'stream', 'info'],
    ['gateway', 'online', 'orbit', 'info'],
    ['gateway', 'offline', 'none', 'subtle'],
    ['heater', 'on', 'rise', 'warning'],
    ['fan', 'on', 'fan', 'muted'],
    ['tv', 'on', 'breathe', 'info'],
  ] as const)('%s / %s → %s (%s)', (scene, state, kind, tone) => {
    const v = resolveSceneVisual({ scene, state })
    expect(v.kind).toBe(kind)
    expect(v.tone).toBe(tone)
  })

  it('an error state is a fast danger ripple on any scene', () => {
    const v = resolveSceneVisual({ scene: 'washer', state: 'error' })
    expect(v).toMatchObject({ kind: 'ripple', tone: 'danger', speed: 'fast' })
  })

  it('params override the derived tone and speed', () => {
    const v = resolveSceneVisual({ scene: 'light', state: 'on', tone: 'success', speed: 'fast' })
    expect(v).toMatchObject({ tone: 'success', speed: 'fast' })
  })

  it('draws the backdrop kind on the node and the tone as a theme class', () => {
    const { container } = render(<HeroScene scene="ac" state="heat" />)
    expect(container.querySelector('[data-backdrop="airflow"]')).not.toBeNull()
    expect(container.querySelector('[data-scene="ac"]')?.className).toContain('text-warning')
  })

  it('the timer track appears only with timer, and reduced motion stops every animation', () => {
    const on = render(<HeroScene scene="heater" state="on" timer level={0.4} />)
    expect(on.container.querySelector('.hs-timer.hs-lv-4')).not.toBeNull()
    expect(on.container.querySelector('style')?.textContent).toContain('prefers-reduced-motion')
    on.unmount()
    const off = render(<HeroScene scene="heater" state="on" />)
    expect(off.container.querySelector('.hs-timer')).toBeNull()
  })

  it('keeps at most two tiles per side and renders the centre slot', () => {
    render(
      <HeroScene
        scene="ac"
        state="cool"
        leftTiles={[
          { label: 'A', value: '1' },
          { label: 'B', value: '2' },
          { label: 'C', value: '3' },
        ]}
        rightTiles={[{ label: 'D', value: '4' }]}
      >
        <span>centre</span>
      </HeroScene>,
    )
    expect(screen.getAllByTestId('scene-tile')).toHaveLength(3)
    expect(screen.queryByText('C')).toBeNull()
    expect(screen.getByTestId('scene-centre').textContent).toBe('centre')
  })
})

describe('HeroCardA', () => {
  it('keeps the top row on one line: nowrap, clipped, title truncates', () => {
    render(
      <HeroCardA
        title="A very long device name that would otherwise wrap onto a second line"
        chips={<span>Midea</span>}
        scene={<HeroScene scene="ac" state="cool" />}
      />,
    )
    const top = screen.getByTestId('hero-card-top')
    expect(top.className).toContain('flex-nowrap')
    expect(top.className).toContain('overflow-hidden')
    expect(top.className).toContain('whitespace-nowrap')
    expect(top.querySelector('h3')?.className).toContain('truncate')
  })

  it('renders foot chips and the history action only when given', () => {
    const bare = render(<HeroCardA title="x" scene={<div />} />)
    expect(screen.queryByTestId('hero-card-foot')).toBeNull()
    bare.unmount()
    render(
      <HeroCardA title="x" scene={<div />} footChips={<i>filter</i>} footAction={<b>History</b>} />,
    )
    expect(screen.getByTestId('hero-card-foot').textContent).toContain('History')
  })
})

describe('DeviceRow', () => {
  it('has the four zones in order', () => {
    render(
      <DeviceRow
        scene={{ scene: 'washer', state: 'run' }}
        name="Washer"
        status="Cycle 42 min left"
        control={<button type="button">Stop</button>}
        fact={<span>820 W</span>}
      />,
    )
    const zones = Array.from(screen.getByTestId('device-row').querySelectorAll('[data-zone]')).map(
      (el) => el.getAttribute('data-zone'),
    )
    expect(zones).toEqual(['scene', 'name', 'control', 'fact'])
    const mini = screen.getByTestId('device-row').querySelector('[data-scene-size="mini"]')
    expect(mini?.getAttribute('data-scene')).toBe('washer')
    expect(mini?.className).toContain('size-11')
  })

  it('status is a single nowrap line, name truncates', () => {
    render(<DeviceRow scene={{ scene: 'light', state: 'on' }} name="Lamp" status="On · 80%" />)
    expect(screen.getByTestId('device-row-status').className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('device-row-status').className).toContain('truncate')
  })

  it('collapses at phone width: the fact zone is hidden below sm, the control stays', () => {
    render(
      <DeviceRow
        scene={{ scene: 'plug', state: 'on' }}
        name="Plug"
        control={<button type="button">Toggle</button>}
        fact={<span>5 W</span>}
      />,
    )
    const row = screen.getByTestId('device-row')
    expect(row.querySelector('[data-zone="fact"]')?.className).toMatch(/\bhidden\b.*\bsm:flex\b/)
    expect(row.querySelector('[data-zone="control"]')?.className).not.toContain('hidden')
    expect(row.className).toContain('grid-cols-[2.75rem_minmax(0,1fr)_auto]')
    expect(row.className).toContain('sm:grid-cols-[2.75rem_minmax(0,1fr)_auto_auto]')
  })

  it('shows a custom icon in front of the animation', () => {
    render(
      <DeviceRow
        scene={{ scene: 'generic', state: 'on', icon: <i data-testid="own" /> }}
        name="X"
      />,
    )
    expect(screen.getByTestId('own')).toBeTruthy()
  })
})

describe('scene tiles', () => {
  it('draw a toned value in its tone and never wrap it', () => {
    render(
      <HeroScene
        scene="washer"
        state="run"
        rightTiles={[
          { label: 'Ends', value: '17:42', tone: 'warning' },
          { label: 'Left', value: '38 min' },
        ]}
      />,
    )
    const [ends, left] = screen.getAllByTestId('scene-tile')
    const endsValue = ends?.lastElementChild
    expect(endsValue?.className).toContain('text-warning')
    expect(endsValue?.className).toContain('whitespace-nowrap')
    expect(left?.lastElementChild?.className).toContain('text-foreground')
  })
})
