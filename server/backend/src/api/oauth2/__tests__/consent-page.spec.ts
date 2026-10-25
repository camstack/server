/**
 * The consent page opens inside the Alexa app's web view (and Home
 * Assistant's) on a phone. Amazon's account-linking requirements: the page
 * must be mobile-friendly. Without a viewport declaration a mobile browser
 * lays it out at desktop width and shrinks it to an unreadable size.
 */
import { describe, expect, it } from 'vitest'
import { renderConsentPage } from '../consent-page.js'

describe('renderConsentPage', () => {
  it('declares a device-width viewport so it is readable on a phone', () => {
    const html = renderConsentPage({
      lang: 'en',
      displayName: 'Alexa Smart Home',
      username: 'reviewer',
      scopeSummary: 'devices: view, control',
      hidden: { state: 's' },
    })
    expect(html).toMatch(/<meta name="viewport" content="width=device-width,initial-scale=1[^"]*">/)
  })
})
