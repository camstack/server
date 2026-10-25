// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { act } from 'react'
import { StableTabPanel } from '../StableTabPanel'

/** Mirrors MAX_HOLD_MS in the component. */
const MAX_HOLD_MS = 1_500

/**
 * The bug: switching a tab unmounts a tall panel and mounts a short loading stub,
 * so the scroll container's height collapses and the browser clamps scrollTop to
 * ~0. StableTabPanel holds the outgoing height so the collapse never happens.
 *
 * jsdom performs no layout — `offsetHeight` is always 0 — so it is stubbed per
 * element to model the heights the real browser would report.
 */

/** Make `offsetHeight` read from a mutable box so the test can change it. */
function stubHeights(get: (el: HTMLElement) => number): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return get(this)
    },
  })
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
  }
}

let restoreHeights: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  restoreHeights?.()
  restoreHeights = undefined
  vi.useRealTimers()
})

describe('StableTabPanel', () => {
  it('applies no min-height before any tab change', () => {
    restoreHeights = stubHeights(() => 3000)
    const { container } = render(
      <StableTabPanel tabKey="a">
        <div>tall</div>
      </StableTabPanel>,
    )
    const outer = container.firstElementChild as HTMLElement
    expect(outer.style.minHeight).toBe('')
  })

  it('holds the outgoing height when the tab changes, so scrollTop cannot clamp', () => {
    // 3000px panel → the replacement's first frame is a 96px `animate-pulse` stub.
    //
    // The stub models what a browser would report — content height, floored by
    // whatever `min-height` is actually applied — reading that from the element's
    // own style rather than from a test-held variable. Otherwise the test would be
    // feeding the component the very number it is supposed to have captured.
    let contentHeight = 3000
    restoreHeights = stubHeights((el) =>
      Math.max(contentHeight, Number.parseFloat(el.style.minHeight || '0')),
    )

    const { container, rerender } = render(
      <StableTabPanel tabKey="a">
        <div>tall panel</div>
      </StableTabPanel>,
    )
    const outer = container.firstElementChild as HTMLElement

    contentHeight = 96 // the loading stub
    act(() => {
      rerender(
        <StableTabPanel tabKey="b">
          <div>loading stub</div>
        </StableTabPanel>,
      )
    })

    // The container must still be 3000px tall, or the browser clamps scrollTop.
    expect(outer.style.minHeight).toBe('3000px')
  })

  it('releases the hold after MAX_HOLD_MS so a genuinely shorter tab leaves no gap', () => {
    let contentHeight = 3000
    restoreHeights = stubHeights(() => contentHeight)

    const { container, rerender } = render(
      <StableTabPanel tabKey="a">
        <div>tall</div>
      </StableTabPanel>,
    )
    const outer = container.firstElementChild as HTMLElement

    contentHeight = 96
    act(() => {
      rerender(
        <StableTabPanel tabKey="b">
          <div>short</div>
        </StableTabPanel>,
      )
    })
    expect(outer.style.minHeight).not.toBe('')

    // ResizeObserver never fires in jsdom, so only the timeout can release it —
    // which is exactly the degradation path the component documents.
    act(() => {
      vi.advanceTimersByTime(MAX_HOLD_MS)
    })
    expect(outer.style.minHeight).toBe('')
  })

  it('releases immediately when the incoming panel is not shorter', () => {
    // Nothing collapsed, so scrollTop was never at risk and there is nothing to
    // hold. Holding anyway would pin a stale height onto a panel that is about to
    // grow past it.
    restoreHeights = stubHeights((el) =>
      Math.max(2000, Number.parseFloat(el.style.minHeight || '0')),
    )
    const { container, rerender } = render(
      <StableTabPanel tabKey="a">
        <div>a</div>
      </StableTabPanel>,
    )
    const outer = container.firstElementChild as HTMLElement

    act(() => {
      rerender(
        <StableTabPanel tabKey="b">
          <div>b</div>
        </StableTabPanel>,
      )
    })
    expect(outer.style.minHeight).toBe('')
  })

  it('re-arms on every subsequent tab change, not just the first', () => {
    let contentHeight = 2000
    restoreHeights = stubHeights((el) =>
      Math.max(contentHeight, Number.parseFloat(el.style.minHeight || '0')),
    )

    const { container, rerender } = render(
      <StableTabPanel tabKey="a">
        <div>a</div>
      </StableTabPanel>,
    )
    const outer = container.firstElementChild as HTMLElement

    // a → b, collapsing to a stub: held at the outgoing 2000.
    contentHeight = 100
    act(() => {
      rerender(
        <StableTabPanel tabKey="b">
          <div>b</div>
        </StableTabPanel>,
      )
    })
    expect(outer.style.minHeight).toBe('2000px')
    act(() => {
      vi.advanceTimersByTime(MAX_HOLD_MS)
    })
    expect(outer.style.minHeight).toBe('')

    // b's content settles at 1200, then b → c collapses again. The second hold
    // must use 1200 — the height as of the last paint — not the stale 2000.
    contentHeight = 1200
    act(() => {
      rerender(
        <StableTabPanel tabKey="b">
          <div>b settled</div>
        </StableTabPanel>,
      )
    })
    contentHeight = 100
    act(() => {
      rerender(
        <StableTabPanel tabKey="c">
          <div>c</div>
        </StableTabPanel>,
      )
    })
    expect(outer.style.minHeight).toBe('1200px')
  })

  it('does not re-arm when the tab is unchanged but children re-render', () => {
    restoreHeights = stubHeights(() => 500)
    const { container, rerender } = render(
      <StableTabPanel tabKey="a">
        <div>first</div>
      </StableTabPanel>,
    )
    const outer = container.firstElementChild as HTMLElement

    act(() => {
      rerender(
        <StableTabPanel tabKey="a">
          <div>second</div>
        </StableTabPanel>,
      )
    })
    // Content churn inside one tab (a query resolving) must not pin the height.
    expect(outer.style.minHeight).toBe('')
  })
})
