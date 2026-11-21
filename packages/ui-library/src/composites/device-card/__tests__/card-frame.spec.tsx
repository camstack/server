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

const WITH_HISTORY = {
  ...COMMON,
  history: { charts: <span>charts</span>, events: null },
}

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

  describe('the history view the state corner opens', () => {
    const withHistory = (historyView?: boolean) => (
      <DeviceCard
        kind="plug"
        common={WITH_HISTORY}
        state={{ label: 'On', since: null, tone: 'primary' }}
        scene={{ image: <span>scene</span> }}
        {...(historyView === undefined ? {} : { historyView })}
      />
    )

    it('is offered by default: the state is a button that opens the view', () => {
      render(withHistory())
      expect(screen.getByTestId('dc-state').tagName).toBe('BUTTON')
    })

    it('historyView={false}: plain state text, no button and no view', () => {
      render(withHistory(false))
      expect(screen.getByTestId('dc-state').tagName).not.toBe('BUTTON')
      expect(screen.queryByRole('button', { name: 'Open the history' })).toBeNull()
    })

    it('a host turns it off for every card below it, and an explicit prop still wins', () => {
      render(
        <DeviceCardFrameProvider frame="card" historyView={false}>
          {withHistory()}
          {withHistory(true)}
        </DeviceCardFrameProvider>,
      )
      expect(screen.getAllByTestId('dc-state').map((el) => el.tagName)).toEqual([
        expect.not.stringMatching(/^BUTTON$/),
        'BUTTON',
      ])
    })

    it('does not open the history view even when asked to start on it', () => {
      render(
        <DeviceCard
          kind="plug"
          common={WITH_HISTORY}
          state={{ label: 'On', since: null, tone: 'primary' }}
          scene={{ image: <span>scene</span> }}
          initialView="history"
          historyView={false}
        />,
      )
      expect(screen.queryByTestId('dc-history')).toBeNull()
      expect(screen.getByText('scene')).toBeTruthy()
    })
  })
})
