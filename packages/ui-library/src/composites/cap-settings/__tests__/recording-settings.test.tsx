// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CamProfile, RecordingBand, RecordingConfig } from '@camstack/types'
vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerListAll: () => ({
    data: [
      {
        id: 101,
        type: 'camera',
        name: 'Front door',
        location: 'Front door',
        features: [],
        isCamera: true,
      },
      {
        id: 3001,
        type: 'sensor',
        name: 'Contatto porta',
        location: 'Front door',
        features: ['contact'],
        isCamera: false,
      },
      {
        id: 3002,
        type: 'sensor',
        name: 'PIR hallway',
        location: 'Hallway',
        features: ['motion'],
        isCamera: false,
      },
      {
        id: 3003,
        type: 'light',
        name: 'Lampada',
        location: 'Front door',
        features: ['light'],
        isCamera: false,
      },
    ],
    isLoading: false,
    error: null,
  }),
}))

import { RecordingSettings } from '../RecordingSettings'

const ALWAYS_CONTINUOUS: RecordingBand = {
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '00:00',
  end: '23:59',
  mode: 'continuous',
}

const ALL_SLOTS: readonly CamProfile[] = ['high', 'mid', 'low']

const baseConfig = (profiles?: CamProfile[]): RecordingConfig => ({
  enabled: true,
  bands: [{ ...ALWAYS_CONTINUOUS }],
  ...(profiles ? { profiles } : {}),
})

const profileButton = (label: string): HTMLElement =>
  screen.getAllByRole('button').find((b) => b.textContent === label)!

const isOn = (btn: HTMLElement): boolean => btn.className.includes('bg-primary')

/** A typed `onSave` spy plus the config it received (throws if never called). */
type SaveSpy = ReturnType<typeof vi.fn<(config: RecordingConfig) => void>>
const savedConfig = (onSave: SaveSpy): RecordingConfig => {
  const [first] = onSave.mock.calls
  if (!first) throw new Error('onSave was never called')
  return first[0]
}

describe('RecordingSettings — profile defaults', () => {
  it('shows only broker-assigned slots, defaulting high+low ON and mid OFF', () => {
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={() => {}}
      />,
    )
    expect(isOn(profileButton('high'))).toBe(true)
    expect(isOn(profileButton('mid'))).toBe(false)
    expect(isOn(profileButton('low'))).toBe(true)
  })

  it('hides a profile the broker has not assigned', () => {
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={['high', 'low']}
        saving={false}
        onSave={() => {}}
      />,
    )
    expect(profileButton('high')).toBeDefined()
    expect(profileButton('low')).toBeDefined()
    expect(screen.getAllByRole('button').some((b) => b.textContent === 'mid')).toBe(false)
  })

  it('reflects an explicit subset', () => {
    render(
      <RecordingSettings
        initial={baseConfig(['high'])}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={() => {}}
      />,
    )
    expect(isOn(profileButton('high'))).toBe(true)
    expect(isOn(profileButton('mid'))).toBe(false)
    expect(isOn(profileButton('low'))).toBe(false)
  })

  it('clicking a profile from the high+low default deselects just that one', () => {
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
      />,
    )
    fireEvent.click(profileButton('high'))
    expect(isOn(profileButton('high'))).toBe(false)
    expect(isOn(profileButton('mid'))).toBe(false)
    expect(isOn(profileButton('low'))).toBe(true)
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(savedConfig(onSave).profiles).toEqual(['low'])
  })
})

describe('RecordingSettings — flat bands, no advanced tab', () => {
  it('does not render a Base/Advanced tab switcher', () => {
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Advanced (bands)' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Base' })).toBeNull()
  })

  it('always shows the band table next to the mode shortcuts', () => {
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={() => {}}
      />,
    )
    expect(screen.getByDisplayValue('00:00')).toBeDefined()
    expect(screen.getByDisplayValue('23:59')).toBeDefined()
    expect(screen.getByText('Add band')).toBeDefined()
  })

  it('continuous shortcut saves ONE always-on band and no mode', () => {
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByText('Save'))
    const saved = savedConfig(onSave)
    expect(saved.bands).toEqual([ALWAYS_CONTINUOUS])
    expect(saved.enabled).toBe(true)
    expect(saved.mode).toBeUndefined()
  })

  it('Off saves no bands at all', () => {
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mode Off' }))
    fireEvent.click(screen.getByText('Save'))
    const saved = savedConfig(onSave)
    expect(saved.bands).toEqual([])
    expect(saved.enabled).toBe(false)
  })

  it('Events puts the trigger on the band, not on the config', () => {
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mode Events' }))
    fireEvent.click(screen.getByLabelText('Motion'))
    fireEvent.click(screen.getByText('Save'))
    const [band] = savedConfig(onSave).bands
    expect(band?.mode).toBe('events')
    expect(band?.triggers).toEqual({ motion: true })
  })

  it('an events band can name the SENSORS that trigger it — the field the schema had and no UI wrote', () => {
    // `RecordingTriggers.sensorDeviceIds` existed for weeks with nothing to
    // set it: the operator saw Motion and Audio and asked where the sensors
    // were. Offered only for devices carrying a source cap (contact, motion,
    // binary, …), the camera's own location first.
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
        sensorContext={{ cameraId: 101, location: 'Front door' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mode Events' }))
    const box = screen.getByRole('combobox', { name: 'Sensors' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'porta' } })
    fireEvent.click(screen.getByRole('option', { name: /Contatto porta/ }))
    expect(screen.queryByRole('option', { name: /Lampada/ })).toBeNull()
    fireEvent.click(screen.getByText('Save'))
    const [band] = savedConfig(onSave).bands
    expect(band?.triggers).toEqual({ sensorDeviceIds: [3001] })
  })

  it('the camera that publishes a signal can be put in the DEVICE-DECIDED mode', () => {
    // D380: the mode, not a band trigger. It saves `deviceDecision: true` with
    // NO bands — there is no hour to program, so there is nothing to schedule.
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
        sensorContext={{ cameraId: 4374, location: null, deviceSignal: 'present' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mode Device decides' }))
    // The band editor is GONE in this mode: it would ask for an hour nobody has.
    expect(screen.queryByRole('button', { name: 'Add band' })).toBeNull()
    fireEvent.click(screen.getByText('Save'))
    const saved = savedConfig(onSave)
    expect(saved.deviceDecision).toBe(true)
    expect(saved.bands).toEqual([])
    expect(saved.enabled).toBe(true)
  })

  it('not-yet-known is a DISABLED mode that says it is checking — never an absent one (D315)', () => {
    const { rerender } = render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={vi.fn()}
        sensorContext={{ cameraId: 101, location: null, deviceSignal: 'pending' }}
      />,
    )
    const pending = screen.getByRole('button', { name: 'Mode Device decides' })
    expect(pending.hasAttribute('disabled')).toBe(true)
    expect(pending.getAttribute('title')).toContain('checking')

    // A camera that ANSWERED with no signal: still present, still disabled, and
    // saying why — an absent control reads as "this build cannot do it".
    rerender(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={vi.fn()}
        sensorContext={{ cameraId: 101, location: null, deviceSignal: 'absent' }}
      />,
    )
    const absent = screen.getByRole('button', { name: 'Mode Device decides' })
    expect(absent.hasAttribute('disabled')).toBe(true)
    expect(absent.getAttribute('title')).toContain('does not report')
  })

  it('a camera ALREADY in the mode can always be switched out of it (D62)', () => {
    // Even with the presence query unanswered: an off switch must always be
    // reachable, or the operator is locked into a mode by a failing query.
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={{ enabled: true, bands: [], deviceDecision: true }}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
        sensorContext={{ cameraId: 4374, location: null, deviceSignal: 'unknown' }}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Mode Device decides' }).hasAttribute('disabled'),
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Mode Off' }))
    fireEvent.click(screen.getByText('Save'))
    const saved = savedConfig(onSave)
    expect(saved.deviceDecision).toBeUndefined()
    expect(saved.enabled).toBe(false)
  })

  it('an events band can name the OBJECT CLASSES that trigger it — person, vehicle, animal', () => {
    // `RecordingTriggers.objectClasses`: the fifth authored field with no
    // control, surfaced by scripts/check-authored-fields-reachable.ts.
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mode Events' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trigger on person' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trigger on vehicle' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trigger on person' }))
    fireEvent.click(screen.getByText('Save'))
    const [band] = savedConfig(onSave).bands
    expect(band?.triggers).toEqual({ objectClasses: ['vehicle'] })
  })

  it('a time-restricted config shows its band times on the same flat form', () => {
    const onSave: SaveSpy = vi.fn()
    const restricted: RecordingConfig = {
      enabled: true,
      bands: [{ days: [1, 2], start: '08:00', end: '20:00', mode: 'continuous' }],
    }
    render(
      <RecordingSettings
        initial={restricted}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
      />,
    )
    expect(screen.getByDisplayValue('08:00')).toBeDefined()
    expect(screen.getByDisplayValue('20:00')).toBeDefined()
    fireEvent.click(screen.getByText('Save'))
    expect(savedConfig(onSave).bands).toEqual(restricted.bands)
  })

  it('removing the last band saves a disabled, band-less config', () => {
    const onSave: SaveSpy = vi.fn()
    render(
      <RecordingSettings
        initial={baseConfig()}
        availableProfiles={ALL_SLOTS}
        saving={false}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByLabelText('Remove band'))
    fireEvent.click(screen.getByText('Save'))
    const saved = savedConfig(onSave)
    expect(saved.bands).toEqual([])
    expect(saved.enabled).toBe(false)
  })
})
