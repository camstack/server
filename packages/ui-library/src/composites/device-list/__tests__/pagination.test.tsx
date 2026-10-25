// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Pagination, computePageButtons } from '../pagination'

describe('computePageButtons', () => {
  it('shows all pages when total <= 7', () => {
    expect(computePageButtons(1, 1)).toEqual([{ kind: 'page', n: 1 }])
    expect(computePageButtons(3, 5)).toEqual([
      { kind: 'page', n: 1 },
      { kind: 'page', n: 2 },
      { kind: 'page', n: 3 },
      { kind: 'page', n: 4 },
      { kind: 'page', n: 5 },
    ])
    expect(computePageButtons(4, 7)).toHaveLength(7)
  })

  it('inserts left ellipsis when current is far from start', () => {
    const out = computePageButtons(20, 28)
    // Expected: 1 … 18 19 20 21 22 … 28
    expect(out[0]).toEqual({ kind: 'page', n: 1 })
    expect(out[1]).toEqual({ kind: 'ellipsis', side: 'left' })
    expect(out.find((b) => b.kind === 'page' && b.n === 20)).toBeDefined()
    expect(out[out.length - 1]).toEqual({ kind: 'page', n: 28 })
  })

  it('inserts right ellipsis when current is far from end', () => {
    const out = computePageButtons(3, 28)
    expect(out[0]).toEqual({ kind: 'page', n: 1 })
    expect(out.findIndex((b) => b.kind === 'ellipsis' && b.side === 'right')).toBeGreaterThan(0)
    expect(out[out.length - 1]).toEqual({ kind: 'page', n: 28 })
  })

  it('inserts both ellipses when current is in the middle', () => {
    const out = computePageButtons(15, 30)
    expect(out.find((b) => b.kind === 'ellipsis' && b.side === 'left')).toBeDefined()
    expect(out.find((b) => b.kind === 'ellipsis' && b.side === 'right')).toBeDefined()
  })
})

describe('<Pagination>', () => {
  it('renders showing-info text', () => {
    render(<Pagination currentPage={2} totalItems={150} pageSize={50} onPageChange={() => {}} />)
    expect(screen.getByText(/Showing 51–100 of 150/i)).toBeDefined()
  })

  it('disables prev on page 1', () => {
    const { container } = render(
      <Pagination currentPage={1} totalItems={150} pageSize={50} onPageChange={() => {}} />,
    )
    const prev = container.querySelector('button[aria-label="Previous page"]') as HTMLButtonElement
    expect(prev?.disabled).toBe(true)
  })

  it('disables next on last page', () => {
    const { container } = render(
      <Pagination currentPage={3} totalItems={150} pageSize={50} onPageChange={() => {}} />,
    )
    const next = container.querySelector('button[aria-label="Next page"]') as HTMLButtonElement
    expect(next?.disabled).toBe(true)
  })

  it('returns null when total <= pageSize (single page, no nav needed)', () => {
    const { container } = render(
      <Pagination currentPage={1} totalItems={5} pageSize={50} onPageChange={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
