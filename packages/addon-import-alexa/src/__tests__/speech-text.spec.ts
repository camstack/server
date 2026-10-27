import { describe, expect, it } from 'vitest'
import { SPEECH_MAX_CHARS } from '../speak/constants.js'
import { speechFromNotification } from '../speak/speech-text.js'

describe('speechFromNotification', () => {
  it('turns a markdown and html template into plain speech', () => {
    const speech = speechFromNotification({
      title: 'Front door',
      body: '**<b>Person</b>** at the [door](https://example.com)',
      format: 'markdown',
      priority: 3,
    })
    expect(speech.text).toBe('Front door. Person at the door')
    expect(speech.text.includes('<')).toBe(false)
    expect(speech.text.includes('*')).toBe(false)
    expect(speech.renderedAs.format).toBe('text')
  })

  it('caps the sentence and reports the cut', () => {
    const speech = speechFromNotification({
      body: 'a'.repeat(SPEECH_MAX_CHARS + 40),
      format: 'text',
      priority: 3,
    })
    expect(speech.text.length).toBeLessThanOrEqual(SPEECH_MAX_CHARS)
    expect(speech.renderedAs.truncated).toBe(true)
  })
})
