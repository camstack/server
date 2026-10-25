import { describe, expect, it } from 'vitest'
import {
  SHARE_DEVICES_HEADER,
  SHARE_KIND_HEADER,
  stripShareHeaders,
} from '../auth/addon-route-share-gate.js'

describe('stripShareHeaders', () => {
  it('drops any share header the CLIENT sent — the gate is the only writer', () => {
    const headers = {
      authorization: 'Bearer share-token-x',
      [SHARE_KIND_HEADER]: 'events-view',
      [SHARE_DEVICES_HEADER]: '1,2,3',
      'x-other': 'kept',
    }
    expect(stripShareHeaders(headers)).toEqual({
      authorization: 'Bearer share-token-x',
      'x-other': 'kept',
    })
  })
})
