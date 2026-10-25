// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RunningBadge, RunningStatusLine } from '../running-badge'

describe('RunningBadge', () => {
  it('marks running, idle, and unknown on data-running', () => {
    const { rerender } = render(
      <RunningBadge running={true}>
        <span>icon</span>
      </RunningBadge>,
    )
    expect(document.querySelector('[data-running="running"]')).toBeTruthy()

    rerender(
      <RunningBadge running={false}>
        <span>icon</span>
      </RunningBadge>,
    )
    expect(document.querySelector('[data-running="idle"]')).toBeTruthy()

    rerender(
      <RunningBadge running={null}>
        <span>icon</span>
      </RunningBadge>,
    )
    expect(document.querySelector('[data-running="unknown"]')).toBeTruthy()
  })
})

describe('RunningStatusLine', () => {
  const now = 1_700_000_000_000

  it('unknown never says Idle', () => {
    render(<RunningStatusLine running={null} since={null} phase={null} now={now} />)
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.queryByText('Idle')).toBeNull()
  })
})
