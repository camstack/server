/// <reference types="@testing-library/jest-dom" />

import type { CameraBrokerStatus } from '@camstack/types'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { BrokerBlock } from '../runtime-blocks'

expect.extend(jestDomMatchers)

vi.mock('@camstack/ui-library', () => ({
  getPhaseVisual: () => ({ label: '', textColor: '', badgeClass: '', dotClass: '' }),
  PhaseIcon: () => null,
}))

/**
 * The broker profile row shows the rate the broker RECEIVES and nothing it
 * cannot measure: its old "→ out fps" read the frame plane's decoded rate,
 * 0 on every live camera since decoding moved to the session decode workers
 * ("26→0fps"). A failed stats read is "—", never a 0-fps stall.
 */
function broker(inFps: number | null): CameraBrokerStatus {
  return {
    profiles: [
      {
        profile: 'high',
        status: 'streaming',
        codec: 'h264',
        width: 1920,
        height: 1080,
        subscribers: 1,
        inFps,
      },
    ],
    webrtcSessions: 0,
    rtspRestream: true,
  }
}

describe('BrokerBlock', () => {
  it('shows the received rate without an output rate', () => {
    render(<BrokerBlock broker={broker(26)} />)

    expect(screen.getByText('26fps')).toBeInTheDocument()
    expect(screen.queryByText(/→/)).not.toBeInTheDocument()
  })

  it('shows an unknown rate as a dash, not as a stalled 0', () => {
    render(<BrokerBlock broker={broker(null)} />)

    const rate = screen.getByText('—fps')
    expect(rate).toBeInTheDocument()
    expect(rate).not.toHaveClass('text-danger')
  })
})
