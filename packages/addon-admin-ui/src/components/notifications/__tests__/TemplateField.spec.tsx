import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { NcTemplateVarDescriptor } from '@camstack/types'
import { renderWithTemplateHub } from '../../../test-setup/device-template-hub'
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
  return (
    <>
      <TemplateField label="Title" value={value} onChange={setValue} vars={list} testId="tf" />
      <output data-testid="stored">{value}</output>
    </>
  )
}

describe('TemplateField', () => {
  it('a chip inserts at the cursor', () => {
    render(renderWithTemplateHub(<Harness initial="ab" list={vars} />))
    const input = screen.getByTestId('tf-input')
    if (!(input instanceof HTMLInputElement)) throw new Error('not an input')
    input.setSelectionRange(1, 1)
    fireEvent.select(input)
    fireEvent.click(screen.getByTestId('tf-chip-camera'))
    expect(input.value).toBe('a{{camera}}b')
  })

  it('warns about a name the hub would print empty', () => {
    render(renderWithTemplateHub(<Harness initial="{{tiles}}" list={vars} />))
    expect(screen.getByTestId('tf-unknown').textContent).toContain('{{tiles}}')
  })

  it('an unanswered catalog shows neither chips nor a warning', () => {
    render(renderWithTemplateHub(<Harness initial="{{tiles}}" list={undefined} />))
    expect(screen.queryByTestId('tf-chip-camera')).toBeNull()
    expect(screen.queryByTestId('tf-unknown')).toBeNull()
  })

  it('groups chips under their heading', () => {
    render(renderWithTemplateHub(<Harness initial="" list={vars} />))
    expect(screen.getByTestId('tf-group-subject')).toBeTruthy()
    expect(screen.getByTestId('tf-group-rule')).toBeTruthy()
  })

  it('an answered catalog with nothing applicable says so, explicitly', () => {
    render(renderWithTemplateHub(<Harness initial="" list={[]} />))
    expect(screen.getByText('No variables for this field.')).toBeTruthy()
  })

  it('shows a device reference as a chip and keeps the stored text exactly as typed', () => {
    render(renderWithTemplateHub(<Harness initial="Stove {{ stufa.temperature }}" list={vars} />))
    expect(screen.getByTestId('tf-chips').textContent).toContain('stufa.temperature')
    expect(screen.getByTestId('stored').textContent).toBe('Stove {{ stufa.temperature }}')
  })

  it('a variable chip inserts beside a device reference without disturbing it', () => {
    render(renderWithTemplateHub(<Harness initial="{{ stufa.temperature }} " list={vars} />))
    fireEvent.click(screen.getByTestId('tf-chip-camera'))
    expect(screen.getByTestId('stored').textContent).toBe('{{ stufa.temperature }} {{camera}}')
  })
})
