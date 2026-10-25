// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HoverZoomImage } from '../hover-zoom-image'

const SRC = 'http://example.test/snapshot.jpg'

// The thumbnail img is decorative (alt="") and the portal preview is
// aria-hidden, so neither exposes the implicit `img` role to the
// accessibility tree. Query the raw <img> elements by tag instead. The
// preview is portalled to document.body, so scope the lookup to the
// whole document rather than the render container.
function imgCount(): number {
  return document.querySelectorAll('img').length
}

function firstImg(): HTMLImageElement | null {
  return document.querySelector('img')
}

describe('HoverZoomImage', () => {
  it('renders the thumbnail img when src is present', () => {
    render(<HoverZoomImage src={SRC} alt="Front cam" />)
    const img = firstImg()
    expect(img?.getAttribute('src')).toBe(SRC)
    // The thumbnail img is decorative — it must not be announced by name.
    expect(img?.getAttribute('alt')).toBe('')
    // The trigger is a focusable button labelled by `alt`.
    expect(screen.getByLabelText('Front cam')).toBeTruthy()
  })

  it('renders a placeholder thumbnail (no img) when src is null', () => {
    render(<HoverZoomImage src={null} alt="Front cam" placeholder="No snapshot yet" />)
    expect(screen.getByLabelText('Front cam')).toBeTruthy()
    expect(firstImg()).toBeNull()
  })

  it('opens the portal preview on mouseEnter and closes it on mouseLeave', () => {
    render(<HoverZoomImage src={SRC} alt="Front cam" caption="Front cam" />)
    const trigger = screen.getByLabelText('Front cam')

    // Closed initially — only the thumbnail img exists.
    expect(imgCount()).toBe(1)

    fireEvent.mouseEnter(trigger)
    // Portal preview adds a second img + the caption text.
    expect(imgCount()).toBe(2)
    expect(screen.getByText('Front cam')).toBeTruthy()

    fireEvent.mouseLeave(trigger)
    expect(imgCount()).toBe(1)
  })

  it('opens the portal preview on focus and closes it on blur', () => {
    render(<HoverZoomImage src={SRC} alt="Front cam" caption="Front cam" />)
    const trigger = screen.getByLabelText('Front cam')

    // Closed initially — only the thumbnail img exists.
    expect(imgCount()).toBe(1)

    fireEvent.focus(trigger)
    // Portal preview adds a second img + the caption text.
    expect(imgCount()).toBe(2)
    expect(screen.getByText('Front cam')).toBeTruthy()

    fireEvent.blur(trigger)
    expect(imgCount()).toBe(1)
  })

  it('shows the placeholder text inside the opened preview when src is null', () => {
    render(<HoverZoomImage src={null} alt="Front cam" placeholder="No snapshot yet" />)
    const trigger = screen.getByLabelText('Front cam')
    fireEvent.mouseEnter(trigger)
    expect(screen.getByText('No snapshot yet')).toBeTruthy()
    // No image at all (thumbnail placeholder + preview placeholder).
    expect(firstImg()).toBeNull()
  })

  it('flips to the placeholder when the thumbnail image errors', () => {
    render(<HoverZoomImage src={SRC} alt="Front cam" placeholder="No image" />)
    const img = firstImg()
    expect(img).not.toBeNull()
    if (img) fireEvent.error(img)
    // After the error the thumbnail falls back to the placeholder box.
    expect(firstImg()).toBeNull()
    const trigger = screen.getByLabelText('Front cam')
    fireEvent.mouseEnter(trigger)
    expect(screen.getByText('No image')).toBeTruthy()
  })

  it('stops click propagation so a row-click is not triggered by the thumbnail', () => {
    let rowClicked = false
    render(
      <div
        onClick={() => {
          rowClicked = true
        }}
      >
        <HoverZoomImage src={SRC} alt="Front cam" />
      </div>,
    )
    fireEvent.click(screen.getByLabelText('Front cam'))
    expect(rowClicked).toBe(false)
  })
})
