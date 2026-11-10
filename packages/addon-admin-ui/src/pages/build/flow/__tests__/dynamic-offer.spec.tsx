/**
 * A `dynamic` offer resolves into a select from what the device answers, and
 * stays a free field when it cannot (D920).
 */
import { vocabularyActionsForDevice } from '@camstack/types'
import type { LooseVocabOpenArg } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTemplateHub } from '../../../../test-setup/device-template-hub'
import { ArgField } from '../ArgField'
import { capRouterKey, dynamicChoicesOf, dynamicReadName, isDynamicOffer } from '../dynamic-offer'

function dynamicArg(id: string): LooseVocabOpenArg {
  const arg = vocabularyActionsForDevice(['vacuum-control', 'battery', 'dishwasher', 'consumables'])
    .find((a) => a.id === id)
    ?.openArgs.find((o) => isDynamicOffer(o.offer))
  if (arg === undefined) throw new Error(`no dynamic arg on ${id}`)
  return arg
}

function offerOf(arg: LooseVocabOpenArg) {
  if (!isDynamicOffer(arg.offer)) throw new Error('not dynamic')
  return arg.offer
}

describe('dynamic offer projection', () => {
  it('a status list of strings becomes choices; a router key is camelCased', () => {
    const offer = offerOf(dynamicArg('vacuum.fanSpeed'))
    expect(dynamicReadName(offer)).toBe('getStatus')
    expect(dynamicChoicesOf({ availableFanSpeeds: ['quiet', 'turbo'] }, offer)).toEqual([
      { value: 'quiet', label: 'quiet' },
      { value: 'turbo', label: 'turbo' },
    ])
    expect(capRouterKey('vacuum-control')).toBe('vacuumControl')
  })

  it('object items use valueKey/labelKey and the where filter', () => {
    const offer = offerOf(dynamicArg('consumables.reset'))
    const status = {
      items: [
        { key: 'filter', label: 'Filter', resettable: true },
        { key: 'brush', label: 'Brush', resettable: false },
      ],
    }
    expect(dynamicChoicesOf(status, offer)).toEqual([{ value: 'filter', label: 'Filter' }])
  })

  it('an answer that is not a list yields no choices', () => {
    const offer = offerOf(dynamicArg('vacuum.fanSpeed'))
    expect(dynamicChoicesOf(null, offer)).toEqual([])
    expect(dynamicChoicesOf({ availableFanSpeeds: 'quiet' }, offer)).toEqual([])
  })
})

describe('ArgField on a dynamic arg', () => {
  const arg = dynamicArg('vacuum.fanSpeed')
  const base = { arg, locale: 'en' as const, variables: [] }

  it('renders the device list as a select and emits the picked value', () => {
    const onChange = vi.fn()
    render(
      <ArgField
        {...base}
        value={{ kind: 'fixed', value: '' }}
        onChange={onChange}
        choices={{
          state: 'ready',
          choices: [
            { value: 'quiet', label: 'Quiet' },
            { value: 'turbo', label: 'Turbo' },
          ],
        }}
      />,
    )
    const select = screen.getByLabelText(arg.label.en)
    expect(select.tagName).toBe('SELECT')
    fireEvent.change(select, { target: { value: 'turbo' } })
    expect(onChange).toHaveBeenCalledWith({ kind: 'fixed', value: 'turbo' })
  })

  it('stays free text while loading or when the list is unavailable', () => {
    for (const choices of [{ state: 'loading' as const }, { state: 'unavailable' as const }]) {
      const { unmount } = render(
        renderWithTemplateHub(
          <ArgField
            {...base}
            value={{ kind: 'fixed', value: 'x' }}
            onChange={vi.fn()}
            choices={choices}
          />,
        ),
      )
      expect(screen.getByLabelText(arg.label.en).tagName).toBe('INPUT')
      unmount()
    }
  })

  it('keeps a stored value the device no longer lists, visibly', () => {
    render(
      <ArgField
        {...base}
        value={{ kind: 'fixed', value: 'ludicrous' }}
        onChange={vi.fn()}
        choices={{ state: 'ready', choices: [{ value: 'quiet', label: 'Quiet' }] }}
      />,
    )
    expect((screen.getByLabelText(arg.label.en) as HTMLSelectElement).value).toBe('ludicrous')
  })
})
