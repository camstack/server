import { projectDeviceRow, type HeroRowModel } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeroRowControls } from '../HeroRowControls'
import { buildModel } from './fixtures'

const NOW = 1_700_000_000_000

const VACUUM = {
  'vacuum-control': {
    state: 'cleaning',
    batteryLevel: 64,
    fanSpeed: null,
    availableFanSpeeds: [],
    progress: null,
    errorCode: null,
    errorLabel: null,
    lastChangedAt: NOW,
  },
}

const MEDIA = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 40,
  isMuted: false,
  source: 'HDMI 1',
  availableSources: ['HDMI 1'],
  currentMedia: { type: 'music', title: 'Song', artist: 'Band' },
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: null,
  lastChangedAt: NOW,
}

const host = (run = vi.fn(), openRemote?: () => void) => ({
  lang: 'en' as const,
  busy: false,
  run,
  ...(openRemote === undefined ? {} : { openRemote }),
})

const mediaRow = (): HeroRowModel => {
  const model = buildModel(
    'media-player',
    ['media-player', 'remote'],
    { 'media-player': MEDIA },
    true,
    ['media-player-volume'],
  )
  return projectDeviceRow({ ...model, remote: { commands: 2, open: remoteOpen() } })
}

function remoteOpen() {
  const model = buildModel('switch', ['remote'], { switch: { on: true, lastChangedAt: NOW } })
  const open = model.remote?.open
  if (open === undefined) throw new Error('no remote action')
  return open
}

describe('HeroRowControls', () => {
  it('a robot row draws the primary and the return-to-base extra', () => {
    const row = projectDeviceRow(buildModel('vacuum', ['vacuum-control'], VACUUM))
    const run = vi.fn()
    render(<HeroRowControls row={row} host={host(run)} />)
    const bar = screen.getByTestId('hero-row-controls')
    expect(bar.children).toHaveLength(2)
    fireEvent.click(within(bar).getByRole('button', { name: 'Return to base' }))
    expect(run.mock.calls[0]?.[0]).toMatchObject({ cap: 'vacuum-control', method: 'returnToBase' })
  })

  it('a player row draws volume and a remote icon that opens the remote, not a call', () => {
    const run = vi.fn()
    const openRemote = vi.fn()
    render(<HeroRowControls row={mediaRow()} host={host(run, openRemote)} />)
    expect(screen.getByTestId('row-slider-volume.level')).toBeTruthy()
    fireEvent.click(screen.getByTestId('row-action-remote.open'))
    expect(openRemote).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })

  it('no remote host, no remote icon; a row without extras draws its primary only', () => {
    render(<HeroRowControls row={mediaRow()} host={host()} />)
    expect(screen.queryByTestId('row-action-remote.open')).toBeNull()
    const { extras: _extras, ...legacy } = projectDeviceRow(
      buildModel('vacuum', ['vacuum-control'], VACUUM),
    )
    render(<HeroRowControls row={legacy} host={host()} />)
    expect(screen.getAllByTestId('hero-row-controls')[1]?.children).toHaveLength(1)
  })
})
