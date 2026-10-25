import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { NcTemplateVarDescriptor } from '@camstack/types'
import { TemplateField } from '../TemplateField'

const vars: NcTemplateVarDescriptor[] = [
  { name: 'camera', label: 'Camera', example: 'Gate', group: 'subject', families: ['rule'] },
  { name: 'rule', label: 'Rule', example: 'Night', group: 'rule', families: ['rule'] },
]

function Harness({
  initial,
  list,
}: {
  readonly initial: string
  readonly list: readonly NcTemplateVarDescriptor[] | undefined
}) {
  const [value, setValue] = useState(initial)
  return <TemplateField label="Title" value={value} onChange={setValue} vars={list} testId="tf" />
}

describe('TemplateField', () => {
  it('a chip inserts at the cursor', () => {
    render(<Harness initial="ab" list={vars} />)
    const input = screen.getByTestId('tf-input')
    if (!(input instanceof HTMLInputElement)) throw new Error('not an input')
    input.setSelectionRange(1, 1)
    fireEvent.select(input)
    fireEvent.click(screen.getByTestId('tf-chip-camera'))
    expect(input.value).toBe('a{{camera}}b')
  })

  it('warns about a name the hub would print empty', () => {
    render(<Harness initial="{{tiles}}" list={vars} />)
    expect(screen.getByTestId('tf-unknown').textContent).toContain('{{tiles}}')
  })

  it('an unanswered catalog shows neither chips nor a warning', () => {
    render(<Harness initial="{{tiles}}" list={undefined} />)
    expect(screen.queryByTestId('tf-chip-camera')).toBeNull()
    expect(screen.queryByTestId('tf-unknown')).toBeNull()
  })

  it('groups chips under their heading', () => {
    render(<Harness initial="" list={vars} />)
    expect(screen.getByTestId('tf-group-subject')).toBeTruthy()
    expect(screen.getByTestId('tf-group-rule')).toBeTruthy()
  })

  it('an answered catalog with nothing applicable says so, explicitly', () => {
    render(<Harness initial="" list={[]} />)
    expect(screen.getByText('No variables for this field.')).toBeTruthy()
  })
})
