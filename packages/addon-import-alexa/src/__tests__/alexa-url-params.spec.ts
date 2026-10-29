import { describe, it, expect } from 'vitest'
import { describeUrlParams, formatUrlParams } from '../alexa-url-params.js'

const URL_WITH_VALUES =
  'https://www.amazon.de/ap/maplanding?openid.oa2.authorization_code=CODEVALUE123&openid.return_to=RETURNVALUE456&openid.assoc_handle=HANDLEVALUE789&openid.mode=MODEVALUE000&arb=ARBVALUE111#FRAGVALUE222'

const VALUES = [
  'CODEVALUE123',
  'RETURNVALUE456',
  'HANDLEVALUE789',
  'MODEVALUE000',
  'ARBVALUE111',
  'FRAGVALUE222',
]

describe('describeUrlParams', () => {
  it('reports path, sorted names and flags', () => {
    const d = describeUrlParams(URL_WITH_VALUES)
    expect(d.path).toBe('/ap/maplanding')
    expect(d.names).toEqual([
      'arb',
      'openid.assoc_handle',
      'openid.mode',
      'openid.oa2.authorization_code',
      'openid.return_to',
    ])
    expect(d.oa2).toBe(true)
    expect(d.returnTo).toBe(true)
  })

  it('flags absence', () => {
    expect(describeUrlParams('/ax/claim?arb=X')).toMatchObject({
      path: '/ax/claim',
      names: ['arb'],
      oa2: false,
      returnTo: false,
    })
  })

  it('never contains a value, in either rendering', () => {
    const out =
      JSON.stringify(describeUrlParams(URL_WITH_VALUES)) + formatUrlParams(URL_WITH_VALUES)
    for (const v of VALUES) expect(out).not.toContain(v)
  })
})
