import { deliverableFields } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { SPEECH_MAX_CHARS } from '../speak/constants.js'
import { alexaTargetKind } from '../speak/provider.js'
import { speechFromNotification } from '../speak/speech-text.js'

describe('speechFromNotification', () => {
  it('speaks the title only — nothing is joined to it (#483)', () => {
    const speech = speechFromNotification({
      title: 'Front door',
      body: 'Person at the door',
      format: 'text',
      priority: 3,
    })
    expect(speech.text).toBe('Front door')
    expect(speech.renderedAs.dropped).toContain('body')
  })

  it('turns a markdown and html title into plain speech', () => {
    const speech = speechFromNotification({
      title: '**<b>Person</b>** at the [door](https://example.com)',
      body: '',
      format: 'markdown',
      priority: 3,
    })
    expect(speech.text).toBe('Person at the door')
    expect(speech.text.includes('<')).toBe(false)
    expect(speech.text.includes('*')).toBe(false)
    expect(speech.renderedAs.format).toBe('text')
  })

  it('caps the sentence and reports the cut', () => {
    const speech = speechFromNotification({
      title: 'a'.repeat(SPEECH_MAX_CHARS + 40),
      body: '',
      format: 'text',
      priority: 3,
    })
    expect(speech.text.length).toBeLessThanOrEqual(SPEECH_MAX_CHARS)
    expect(speech.renderedAs.truncated).toBe(true)
  })
})

describe('the Alexa kind declares what it delivers', () => {
  it('a title, and a priority (silent vs announce) — no body, picture or buttons', () => {
    expect(deliverableFields(alexaTargetKind().caps)).toEqual(['title', 'priority'])
  })
})
