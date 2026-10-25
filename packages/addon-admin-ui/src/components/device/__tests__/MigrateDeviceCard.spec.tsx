/**
 * The "Migrate to…" card — the three things it must never get wrong.
 *
 *  1. **A non-empty `sourceStillLive` is rendered as still-live, not as a
 *     success.** The cap returns no success flag; a card that invented one
 *     would be exactly the surface the cap was shaped to prevent.
 *  2. **`not-offered` is not counted as still live.** "This camera never had a
 *     microphone" and "the microphone could not be switched off" are different
 *     answers, and only the second is an instruction to go pull a plug.
 *  3. **The confirm gate cannot be skipped.** The operation exchanges two
 *     device identities and has no undo; a declined dialog must leave the hub
 *     untouched.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  // Render the English defaults with their interpolations resolved — the same
  // strings the operator sees.
  useTranslation: () => ({
    t: (_key: string, fallback?: string, vars?: Record<string, unknown>) => {
      if (typeof fallback !== 'string') return ''
      if (vars === undefined) return fallback
      return fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars[name] ?? ''))
    },
  }),
}))

const state = vi.hoisted(() => ({
  devices: undefined as unknown,
  result: undefined as unknown,
  error: null as { message: string } | null,
  confirmAnswer: true,
}))

const migrateMutate = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())

vi.mock('@camstack/ui-library', () => ({
  useDeviceManagerListAll: () => ({ data: state.devices, isLoading: false, error: null }),
  useDeviceManagerMigrateDevice: () => ({
    mutate: migrateMutate,
    isPending: false,
    data: state.result,
    error: state.error,
  }),
  useConfirm: () => confirmSpy,
}))

import { MigrateDeviceCard } from '../MigrateDeviceCard'

const OLD = 102
const NEW = 992

function fleet() {
  return [
    { id: OLD, name: 'Driveway', isCamera: true },
    { id: NEW, name: 'Driveway (new)', isCamera: true },
    { id: 41, name: 'Hall light', isCamera: false },
  ]
}

function renderCard(): void {
  render(<MigrateDeviceCard deviceId={OLD} deviceName="Driveway" />)
}

/** Pick the replacement, then press Migrate and let the confirm settle. */
async function chooseAndMigrate(targetId = NEW): Promise<void> {
  fireEvent.change(screen.getByLabelText('Replacement camera'), {
    target: { value: String(targetId) },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Migrate' }))
  await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
}

beforeEach(() => {
  migrateMutate.mockReset()
  confirmSpy.mockReset()
  confirmSpy.mockImplementation(() => Promise.resolve(state.confirmAnswer))
  state.devices = fleet()
  state.result = undefined
  state.error = null
  state.confirmAnswer = true
})

afterEach(() => {
  cleanup()
})

describe('MigrateDeviceCard — the target picker', () => {
  it('offers adopted cameras and never the device itself', () => {
    renderCard()
    const options = screen
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
    expect(options).toContain(String(NEW))
    expect(options).not.toContain(String(OLD))
    // Non-cameras are not plausible replacements for a camera.
    expect(options).not.toContain('41')
  })

  it('an UNANSWERED fleet query never claims there is nothing to migrate to', () => {
    state.devices = undefined
    renderCard()
    expect(screen.queryByText(/nothing to migrate to/)).toBeNull()
    expect(screen.getByText('Reading the fleet…')).toBeTruthy()
  })

  it('an ANSWERED query with no other camera says so', () => {
    state.devices = [{ id: OLD, name: 'Driveway', isCamera: true }]
    renderCard()
    expect(screen.getByText(/nothing to migrate to/)).toBeTruthy()
  })
})

describe('MigrateDeviceCard — the confirm gate', () => {
  it('a DECLINED confirmation leaves the hub untouched', async () => {
    state.confirmAnswer = false
    renderCard()
    await chooseAndMigrate()
    await waitFor(() => expect(migrateMutate).not.toHaveBeenCalled())
  })

  it('the dialog states what the number carries with it, before anything runs', async () => {
    renderCard()
    await chooseAndMigrate()
    const options = confirmSpy.mock.calls[0]?.[0] as { title: string; message: string }
    expect(options.title).toContain('Driveway (new)')
    expect(options.message).toContain('102')
    expect(options.message).toMatch(/recording/i)
    expect(options.message).toMatch(/cannot be undone/i)
  })

  it('only an ACCEPTED confirmation issues the migration, with source and target', async () => {
    renderCard()
    await chooseAndMigrate()
    await waitFor(() => expect(migrateMutate).toHaveBeenCalledTimes(1))
    expect(migrateMutate).toHaveBeenCalledWith({ sourceId: OLD, targetId: NEW })
  })
})

describe('MigrateDeviceCard — the report', () => {
  it('a non-empty sourceStillLive renders as STILL LIVE and never as success', () => {
    state.result = {
      sourceId: OLD,
      targetId: NEW,
      swapped: true,
      switches: [
        {
          deviceId: OLD,
          switchId: 'device-audio',
          outcome: 'unreachable',
          detail: 'ECONNREFUSED 192.0.2.44:80',
        },
      ],
      sourceStillLive: ['device-audio'],
    }
    renderCard()
    expect(screen.getByText(/STILL RUNNING on the old hardware/)).toBeTruthy()
    expect(screen.getByText('Camera microphone')).toBeTruthy()
    expect(screen.getByText(/ECONNREFUSED 192\.0\.2\.44:80/)).toBeTruthy()
    // The quiet banner is the ONLY success-shaped claim this card can make,
    // and this result does not entitle it to one.
    expect(screen.queryByText(/the old hardware is quiet/)).toBeNull()
  })

  it('an empty sourceStillLive is the quiet outcome, rendered distinctly', () => {
    state.result = {
      sourceId: OLD,
      targetId: NEW,
      swapped: true,
      switches: [{ deviceId: OLD, switchId: 'recording', outcome: 'off' }],
      sourceStillLive: [],
    }
    renderCard()
    expect(screen.getByText(/the old hardware is quiet/)).toBeTruthy()
    expect(screen.queryByText(/STILL RUNNING on the old hardware/)).toBeNull()
  })

  it('a not-offered switch is reported as never offered, NOT as still live', () => {
    state.result = {
      sourceId: OLD,
      targetId: NEW,
      swapped: true,
      switches: [
        {
          deviceId: OLD,
          switchId: 'device-audio',
          outcome: 'not-offered',
          detail: 'camera does not offer audio',
        },
        { deviceId: OLD, switchId: 'privacy-mask', outcome: 'unreachable', detail: 'timed out' },
      ],
      sourceStillLive: ['privacy-mask'],
    }
    renderCard()
    const neverOffered = screen.getByText(/never offered these/).closest('div')?.parentElement
    const stillLive = screen
      .getByText(/STILL RUNNING on the old hardware/)
      .closest('div')?.parentElement
    expect(neverOffered?.textContent).toContain('Camera microphone')
    expect(stillLive?.textContent).toContain('Privacy mask')
    expect(stillLive?.textContent).not.toContain('Camera microphone')
  })
})
