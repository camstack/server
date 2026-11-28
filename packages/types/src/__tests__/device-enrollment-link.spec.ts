import { describe, expect, it } from 'vitest'
import { buildDeviceEnrollmentLink, parseDeviceEnrollmentLink } from '../auth/device-certificate.js'

describe('device enrollment deep link', () => {
  it('is emitted on the dominevo scheme', () => {
    const link = buildDeviceEnrollmentLink({ hub: 'https://hub.example.com', code: 'c1' })
    expect(link.startsWith('dominevo://enroll?')).toBe(true)
  })

  it('still reads a link minted for the previous app scheme', () => {
    for (const scheme of ['dominevo', 'dominevo.dev', 'camstack', 'camstack.dev']) {
      const link = buildDeviceEnrollmentLink({ hub: 'https://hub.example.com', code: 'c1', scheme })
      expect(parseDeviceEnrollmentLink(link), scheme).toMatchObject({ code: 'c1' })
    }
    expect(parseDeviceEnrollmentLink('evil://enroll?code=c1')).toBeNull()
  })
})
