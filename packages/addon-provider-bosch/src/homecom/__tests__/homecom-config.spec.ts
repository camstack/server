import { describe, expect, it } from 'vitest'
import { HOMECOM_POINTT_API_ORIGIN, homeComApiBase, homeComConfigSchema } from '../config.js'

describe('homeCom config', () => {
  it('uses one PointT origin for eu and us (homecom_alt)', () => {
    expect(homeComApiBase('eu')).toBe(HOMECOM_POINTT_API_ORIGIN)
    expect(homeComApiBase('us')).toBe(HOMECOM_POINTT_API_ORIGIN)
  })

  it('marks username as secret in schema meta', () => {
    const username = homeComConfigSchema.shape.username
    expect(username.meta()?.secret).toBe(true)
  })
})
