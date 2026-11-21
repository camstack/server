// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../camera-stream-player', () => ({
  CameraStreamPlayer: () => <div data-testid="player" />,
}))

import { StreamPanel, type StreamPanelProps } from '../stream-panel'

const never = vi.fn()

afterEach(cleanup)

describe('the stream selector draws exactly one chevron', () => {
  it('the profile select carries the library chevron and no second arrow', async () => {
    const props = {
      serverUrl: 'http://hub',
      createSession: never,
      sendAnswer: never,
      handleOffer: never,
      getIceServers: never,
      addIceCandidate: never,
      getIceCandidates: never,
      closeSession: never,
      getSessionState: never,
      streams: [
        { id: 'auto', label: 'Auto' },
        { id: 'high', label: 'High' },
      ],
    } as unknown as StreamPanelProps
    render(<StreamPanel {...props} />)
    await act(async () => undefined)
    const trigger = screen.getByTestId('stream-profile-select')
    const field = trigger.parentElement?.parentElement
    expect(field).not.toBeNull()
    // The library Select owns its chevron; the field holds one arrow in total.
    expect(field?.querySelectorAll('svg')).toHaveLength(1)
  })
})
