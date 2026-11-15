// @vitest-environment jsdom
/**
 * The tag input's text box is the library `Input` primitive, not a raw
 * `<input>` styled on the spot: the primitive is wrapped with a marker and the
 * combobox must carry it.
 */
import { render, screen } from '@testing-library/react'
import { forwardRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TagRegistry } from '../use-tag-registry'

const registry: TagRegistry = {
  entries: [],
  failed: false,
  presence: 'present',
  setStyle: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}

vi.mock('../use-tag-registry', () => ({ useTagRegistry: () => registry }))

vi.mock('../../../primitives/input', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../primitives/input')>()
  const Marked = forwardRef<HTMLInputElement, import('../../../primitives/input').InputProps>(
    (props, ref) => <actual.Input ref={ref} data-primitive="input" {...props} />,
  )
  return { ...actual, Input: Marked }
})

const { TagInput } = await import('../tag-input')

describe('TagInput — primitive', () => {
  it('the combobox is the library Input', () => {
    render(<TagInput value={['Garden']} onChange={() => {}} label="Tags" />)
    expect(screen.getByRole('combobox', { name: 'Tags' }).getAttribute('data-primitive')).toBe(
      'input',
    )
  })
})
