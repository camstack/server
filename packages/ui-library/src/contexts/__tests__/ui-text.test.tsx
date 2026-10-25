import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { defaultUiText, renderTagged, UiTextProvider, UiTrans, useUiText } from '../ui-text'

function Probe(): ReactElement {
  const t = useUiText()
  return <p>{t('k.probe', '{{n}} cameras', { n: 3 })}</p>
}

describe('ui-text', () => {
  it('renders the English fallback, interpolated, without a provider', () => {
    render(<Probe />)
    expect(screen.getByText('3 cameras')).toBeTruthy()
  })

  it('picks the plural form from the count', () => {
    const fallback = { one: '{{count}} camera', other: '{{count}} cameras' }
    expect(defaultUiText('k', fallback, { count: 1 })).toBe('1 camera')
    expect(defaultUiText('k', fallback, { count: 2 })).toBe('2 cameras')
  })

  it('uses the host translator when one is provided', () => {
    render(
      <UiTextProvider t={(key) => `[${key}]`}>
        <Probe />
      </UiTextProvider>,
    )
    expect(screen.getByText('[k.probe]')).toBeTruthy()
  })

  it('wraps tagged spans in the given components', () => {
    const nodes = renderTagged('Open <0>Settings</0> first', [<b key="b" />])
    expect(nodes).toHaveLength(3)
    render(<UiTrans uiKey="k.t" fallback="Open <0>Settings</0>" components={[<b key="b" />]} />)
    expect(screen.getByText('Settings').tagName).toBe('B')
  })
})
