import { describe, expect, it } from 'vitest'
import { draftFromCreateLink } from '../../components/composition-editor/helper-form-model'
import { terminalCameraCreatePath } from '../customization-routes'

describe('the Terminal camera create link', () => {
  it('opens Build-your-self on the Terminal camera template, terminal preselected', () => {
    const path = terminalCameraCreatePath('i 2')
    const params = new URL(path, 'http://x').searchParams
    expect(params.get('tab')).toBe('custom-device')
    expect(params.get('new')).toBe('helper')
    expect(draftFromCreateLink(params)).toEqual({
      kind: 'terminal',
      name: '',
      room: '',
      terminalId: 'i 2',
    })
  })

  it('a link with no template, or an unknown one, starts on the picker', () => {
    expect(draftFromCreateLink(new URLSearchParams(''))).toBeNull()
    expect(draftFromCreateLink(new URLSearchParams('template=nope'))).toBeNull()
  })

  it('a Terminal camera link with no terminal leaves the terminal to pick', () => {
    expect(draftFromCreateLink(new URLSearchParams('template=terminal'))).toEqual({
      kind: 'terminal',
      name: '',
      room: '',
      terminalId: null,
    })
  })
})
