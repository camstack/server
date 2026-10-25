import { BrokerConsumerAttributionSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RTSP_DESCRIBE_WARMUP_ATTRIBUTION } from '../rtsp-listen-server.js'

describe('RTSP DESCRIBE warm-up attribution', () => {
  it('names the real consumer, never `unknown`, and is a valid attribution', () => {
    expect(RTSP_DESCRIBE_WARMUP_ATTRIBUTION.kind).toBe('rtsp-listen')
    expect(
      BrokerConsumerAttributionSchema.safeParse(RTSP_DESCRIBE_WARMUP_ATTRIBUTION).success,
    ).toBe(true)
  })
})
