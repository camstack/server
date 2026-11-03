// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { BottomSheet } from '../bottom-sheet'

describe('BottomSheet', () => {
  it('mounts no fixed layer while closed', () => {
    const { container } = render(
      <BottomSheet open={false} onClose={vi.fn()}>
        <span>x</span>
      </BottomSheet>,
    )
    expect(container.querySelector('.fixed')).toBeNull()
  })

  it('closes from its backdrop while open', () => {
    const onClose = vi.fn()
    const { container } = render(
      <BottomSheet open onClose={onClose}>
        <span>x</span>
      </BottomSheet>,
    )
    container.querySelector<HTMLElement>('.inset-0')?.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
