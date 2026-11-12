import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { draftPatchOfLearned, LearnButton } from '../LearnButton'

let info: { learn: boolean } | undefined = { learn: true }
const learnCall = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useIrTransmitterGetInfo: () => ({ data: info }),
    useIrTransmitterLearn: () => ({ mutateAsync: learnCall, isPending: false }),
  }
})

beforeEach(() => {
  info = { learn: true }
  learnCall.mockReset()
})

describe('draftPatchOfLearned', () => {
  it('keeps a native code as native', () => {
    expect(
      draftPatchOfLearned({
        native: { format: 'tuya', code: 'BAD' },
        timings: [1, -1],
        carrierHz: null,
      }),
    ).toEqual({ encoding: 'native', nativeFormat: 'tuya', code: 'BAD', carrierKhz: '' })
  })
  it('keeps the timings as a raw code when there is no native code', () => {
    expect(
      draftPatchOfLearned({ native: null, timings: [9000, -4500, 560], carrierHz: 38000 }),
    ).toEqual({ encoding: 'raw', code: '9000, -4500, 560', carrierKhz: '38' })
  })
})

describe('LearnButton', () => {
  it('is absent when the transmitter cannot learn', () => {
    info = { learn: false }
    render(<LearnButton transmitterId={5} onLearned={vi.fn()} />)
    expect(screen.queryByTestId('source-learn')).toBeNull()
  })

  it('asks the transmitter and hands the patch back', async () => {
    learnCall.mockResolvedValue({
      native: { format: 'tuya', code: 'XYZ' },
      timings: [1, -1],
      carrierHz: null,
    })
    const onLearned = vi.fn()
    render(<LearnButton transmitterId={5} onLearned={onLearned} />)
    fireEvent.click(screen.getByTestId('source-learn'))
    await waitFor(() => expect(onLearned).toHaveBeenCalled())
    expect(learnCall).toHaveBeenCalledWith({ deviceId: 5 })
    expect(onLearned.mock.calls[0]?.[0]).toMatchObject({ encoding: 'native', code: 'XYZ' })
  })

  it('shows the error the hub answered with', async () => {
    learnCall.mockRejectedValue(new Error('No code arrived in time.'))
    render(<LearnButton transmitterId={5} onLearned={vi.fn()} />)
    fireEvent.click(screen.getByTestId('source-learn'))
    expect((await screen.findByTestId('source-learn-error')).textContent).toBe(
      'No code arrived in time.',
    )
  })
})
