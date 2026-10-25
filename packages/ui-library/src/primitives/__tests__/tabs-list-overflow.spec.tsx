// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Tabs, TabsList, TabsTrigger } from '../tabs'
import { readTabStripOverflow } from '../tabs-list-scroll'

function stripShell(): HTMLElement {
  const list = screen.getByRole('tablist')
  const shell = list.parentElement
  if (shell === null) throw new Error('tab strip shell not found')
  return shell
}

function mockStripGeometry(
  el: HTMLElement,
  geometry: { scrollWidth: number; clientWidth: number; scrollLeft: number },
): void {
  Object.defineProperty(el, 'scrollWidth', {
    configurable: true,
    value: geometry.scrollWidth,
  })
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: geometry.clientWidth,
  })
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    writable: true,
    value: geometry.scrollLeft,
  })
}

describe('readTabStripOverflow', () => {
  it('reports no overflow when the strip fits', () => {
    const el = document.createElement('div')
    mockStripGeometry(el, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 })
    expect(readTabStripOverflow(el)).toEqual({ overflowLeft: false, overflowRight: false })
  })

  it('reports right overflow at scroll origin', () => {
    const el = document.createElement('div')
    mockStripGeometry(el, { scrollWidth: 400, clientWidth: 200, scrollLeft: 0 })
    expect(readTabStripOverflow(el)).toEqual({ overflowLeft: false, overflowRight: true })
  })

  it('reports left overflow when scrolled past the start', () => {
    const el = document.createElement('div')
    mockStripGeometry(el, { scrollWidth: 400, clientWidth: 200, scrollLeft: 120 })
    expect(readTabStripOverflow(el)).toEqual({ overflowLeft: true, overflowRight: true })
  })

  it('reports no right overflow when scrolled to the end', () => {
    const el = document.createElement('div')
    mockStripGeometry(el, { scrollWidth: 400, clientWidth: 200, scrollLeft: 200 })
    expect(readTabStripOverflow(el)).toEqual({ overflowLeft: true, overflowRight: false })
  })
})

describe('TabsList overflow affordance', () => {
  it('sets no overflow data attributes when tabs fit', async () => {
    render(
      <Tabs value="a" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="a">One</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
    const shell = stripShell()
    mockStripGeometry(screen.getByRole('tablist'), {
      scrollWidth: 100,
      clientWidth: 100,
      scrollLeft: 0,
    })
    fireEvent.scroll(screen.getByRole('tablist'))
    await waitFor(() => {
      expect(shell.hasAttribute('data-tab-strip-overflow-left')).toBe(false)
      expect(shell.hasAttribute('data-tab-strip-overflow-right')).toBe(false)
    })
  })

  it('sets right overflow when tabs extend past the viewport', async () => {
    render(
      <Tabs value="b" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="a">Assignments</TabsTrigger>
          <TabsTrigger value="b">Palette</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
    const list = screen.getByRole('tablist')
    mockStripGeometry(list, { scrollWidth: 500, clientWidth: 200, scrollLeft: 0 })
    fireEvent.scroll(list)
    const shell = stripShell()
    await waitFor(() => {
      expect(shell.hasAttribute('data-tab-strip-overflow-right')).toBe(true)
      expect(shell.hasAttribute('data-tab-strip-overflow-left')).toBe(false)
    })
  })

  it('sets left overflow after the strip is scrolled', async () => {
    render(
      <Tabs value="b" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="a">First</TabsTrigger>
          <TabsTrigger value="b">Last</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
    const list = screen.getByRole('tablist')
    mockStripGeometry(list, { scrollWidth: 500, clientWidth: 200, scrollLeft: 150 })
    fireEvent.scroll(list)
    await waitFor(() => {
      expect(stripShell().hasAttribute('data-tab-strip-overflow-left')).toBe(true)
    })
  })
})
