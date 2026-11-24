// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DummyInline } from '../dummy-hero-card'
import type { DeviceControlProps } from '../control-registry'

describe('DummyInline', () => {
  it('renders nothing, not a dash', () => {
    const { container } = render(<>{DummyInline({} as DeviceControlProps)}</>)
    expect(container.textContent).toBe('')
    expect(container.childElementCount).toBe(0)
  })
})
