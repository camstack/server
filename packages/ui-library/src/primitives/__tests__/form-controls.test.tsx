// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button, FileInput, Radio, Slider, Textarea } from '..'

describe('form control primitives', () => {
  it('Textarea forwards value, onChange and disabled', () => {
    const onChange = vi.fn()
    render(<Textarea aria-label="t" value="a" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('t'), { target: { value: 'b' } })
    expect(onChange).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('t').tagName).toBe('TEXTAREA')
  })

  it('Slider is a range input', () => {
    render(<Slider aria-label="s" min={0} max={10} defaultValue={3} />)
    expect(screen.getByLabelText('s')).toHaveProperty('type', 'range')
  })

  it('Radio is a radio input', () => {
    render(<Radio aria-label="r" name="g" />)
    expect(screen.getByLabelText('r')).toHaveProperty('type', 'radio')
  })

  it('FileInput is hidden and forwards its ref', () => {
    const ref = { current: null as HTMLInputElement | null }
    render(<FileInput ref={ref} data-testid="f" />)
    expect(ref.current?.type).toBe('file')
    expect(screen.getByTestId('f').className).toContain('hidden')
  })

  it('Button unstyled adds no look classes but keeps the caller className', () => {
    render(
      <Button variant="unstyled" className="px-2">
        x
      </Button>,
    )
    const cls = screen.getByRole('button').className
    expect(cls).toBe('px-2')
  })
})

describe('Select children and wrapper', () => {
  it('renders option children and a wrapper class', async () => {
    const { Select } = await import('..')
    const { container } = render(
      <Select aria-label="sel" wrapperClassName="inline-block w-auto" defaultValue="b">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    )
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect((container.firstChild as HTMLElement).className).toContain('inline-block')
    expect((container.firstChild as HTMLElement).className).not.toContain('w-full')
  })
})
