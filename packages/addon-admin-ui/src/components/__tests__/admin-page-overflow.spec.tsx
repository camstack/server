// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AdminPage } from '../AdminPage'

describe('AdminPage — page never scrolls horizontally', () => {
  it('outer wrapper clips horizontal overflow', () => {
    // The unified DeviceList table scrolls its OWN body (overflow-x-auto with a
    // sticky NAME column); the page wrapper must NOT also h-scroll, so a wide
    // table can never push the whole page sideways on a phone.
    const { container } = render(
      <AdminPage title="Devices">
        <div>body</div>
      </AdminPage>,
    )
    const outer = container.firstElementChild
    expect(outer?.className).toMatch(/overflow-x-(clip|hidden)/)
  })

  it('does not become a scroll container (which would break descendant sticky)', () => {
    // `overflow-x-hidden` promotes overflow-y from `visible` to `auto` (CSS
    // Overflow: `visible` is not combinable with `hidden`/`auto`/`scroll`), making
    // this div the nearest scroll container for everything inside — which silently
    // disables `position: sticky`. `FormSaveBar` is `sticky bottom-0` and never
    // pinned on any AdminPage because of it.
    //
    // `overflow-x-clip` clips the same way but combines with `visible`, so the
    // vertical axis is left alone.
    const { container } = render(
      <AdminPage title="Devices">
        <div>body</div>
      </AdminPage>,
    )
    const outer = container.firstElementChild
    expect(outer?.className).toContain('overflow-x-clip')
    expect(outer?.className).not.toContain('overflow-x-hidden')
  })
})
