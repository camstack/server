// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mockupCommon } from '../__fixtures__/common'
import { DeviceCard, DeviceCardFrameProvider } from '../shell/DeviceCard'

afterEach(cleanup)

const COMMON = mockupCommon({
  name: 'Washer plug',
  integration: 'Homematic (Casa)',
  watts: 38,
  supplyName: 'Laundry',
  consumables: [],
  remote: [],
})

function card(frame?: 'card' | 'bare') {
  return (
    <DeviceCard
      kind="plug"
      common={COMMON}
      state={{ label: 'On', since: null, tone: 'primary' }}
      scene={{ image: <span>scene</span> }}
      {...(frame === undefined ? {} : { frame })}
    />
  )
}

describe('DeviceCard frame', () => {
  it('draws its own frame and top line by default (the admin card)', () => {
    render(card())
    const article = screen.getByTestId('device-card')
    expect(article.getAttribute('data-frame')).toBe('card')
    expect(article.className).toContain('border')
    expect(article.className).toContain('bg-surface')
    expect(article.className).toContain('max-w-85')
    expect(screen.getByTestId('dc-top').textContent).toContain('Homematic (Casa)')
  })

  it('bare: no border, surface, padding or max width, and no top line', () => {
    render(card('bare'))
    const article = screen.getByTestId('device-card')
    expect(article.getAttribute('data-frame')).toBe('bare')
    for (const cls of ['border', 'bg-surface', 'rounded-3xl', 'p-3.5', 'max-w-85', 'max-w-180']) {
      expect(article.className.split(' ')).not.toContain(cls)
    }
    expect(screen.queryByTestId('dc-top')).toBeNull()
    expect(screen.getByText('scene')).toBeTruthy()
  })

  it('a host frames every card below it, and an explicit prop still wins', () => {
    render(
      <DeviceCardFrameProvider frame="bare">
        {card()}
        {card('card')}
      </DeviceCardFrameProvider>,
    )
    const frames = screen.getAllByTestId('device-card').map((a) => a.getAttribute('data-frame'))
    expect(frames).toEqual(['bare', 'card'])
  })
})
