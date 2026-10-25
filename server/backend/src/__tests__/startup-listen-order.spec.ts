import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN = path.resolve(__dirname, '..', 'main.ts')

describe('server startup readiness ordering', () => {
  it('opens the control plane before waiting for forked UI capabilities', () => {
    const source = fs.readFileSync(MAIN, 'utf-8')
    const uiRoutes = source.indexOf("fastify.get('/viewer'")
    const listen = source.indexOf('await app.listen(port, listenHost)')
    const uiResolution = source.indexOf('void Promise.all([resolveAdminUi(), resolveViewerUi()])')

    expect(uiRoutes).toBeGreaterThan(-1)
    expect(listen).toBeGreaterThan(uiRoutes)
    expect(uiResolution).toBeGreaterThan(listen)
  })
})
