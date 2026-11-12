import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GenericHero } from '../GenericHero'

const BASE = {
  deviceId: 7,
  deviceName: 'Gateway',
  deviceType: 'generic',
  provider: 'rtsp',
  features: [],
} as const

afterEach(cleanup)

describe('GenericHero reachability', () => {
  it('a reachable device carries no "Online" badge', () => {
    render(<GenericHero {...BASE} isOnline />)
    expect(screen.queryByText(/online/i)).toBeNull()
  })

  it('an offline device still says it is offline', () => {
    render(<GenericHero {...BASE} isOnline={false} />)
    expect(screen.getByText(/offline/i)).toBeTruthy()
  })
})
