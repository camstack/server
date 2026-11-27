import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useMeshNetworkTitle } from '../mesh-labels'

describe('useMeshNetworkTitle', () => {
  const title = () => renderHook(() => useMeshNetworkTitle()).result.current

  it('names a zigbee network by the last four of its id', () => {
    expect(
      title()({ id: '00124b0001abcd', name: null, technology: 'zigbee', channel: 15, panId: 1 }, 0),
    ).toBe('Zigbee network abcd')
  })

  it('a reported name wins', () => {
    expect(
      title()({ id: 'x', name: 'Home', technology: 'zigbee', channel: null, panId: null }, 0),
    ).toBe('Home')
  })
})
