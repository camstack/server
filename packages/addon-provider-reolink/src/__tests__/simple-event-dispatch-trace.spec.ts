import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shouldTraceSimpleEventDispatch } from '../simple-event-dispatch-trace.js'

/**
 * Hub-child simpleEvents arrive on the parent's Baichuan socket and are
 * forwarded by `ReolinkHubSession.routeSimpleEvent`. The camera's own
 * `handleSimpleEvent` info line is tagged with the CHILD deviceId — so
 * filtering the Logs tab to the Hub shows nothing, and enabling debug on
 * a hub-child does not wire lib tracing (the child has no socket).
 *
 * The hub must therefore log the inbound event on ITS logger, before
 * dispatch, when the target camera (or the hub itself) is under debug.
 */

const here = dirname(fileURLToPath(import.meta.url))
const hubSource = readFileSync(resolve(here, '../reolink-hub-session.ts'), 'utf8')

function sliceMethodBody(source: string, methodSignature: string): string {
  const start = source.indexOf(methodSignature)
  if (start === -1) throw new Error(`method not found: ${methodSignature}`)
  let i = source.indexOf('{', start)
  if (i === -1) throw new Error(`opening brace not found for ${methodSignature}`)
  const bodyStart = i
  let depth = 0
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`closing brace not found for ${methodSignature}`)
}

const OFF = {
  hubDebugGeneral: false,
  hubSocketFlags: [] as readonly string[],
  childDebugGeneral: false,
  childSocketFlags: [] as readonly string[],
}

describe('shouldTraceSimpleEventDispatch', () => {
  it('is silent when neither hub nor child is under debug', () => {
    expect(shouldTraceSimpleEventDispatch(OFF)).toBe(false)
  })

  it('traces when the target camera has debugGeneral', () => {
    expect(shouldTraceSimpleEventDispatch({ ...OFF, childDebugGeneral: true })).toBe(true)
  })

  it('traces when the target camera has the Events socket flag', () => {
    expect(shouldTraceSimpleEventDispatch({ ...OFF, childSocketFlags: ['traceEvents'] })).toBe(true)
  })

  it('traces when the hub itself has debugGeneral', () => {
    expect(shouldTraceSimpleEventDispatch({ ...OFF, hubDebugGeneral: true })).toBe(true)
  })

  it('traces when the hub has the Events socket flag', () => {
    expect(shouldTraceSimpleEventDispatch({ ...OFF, hubSocketFlags: ['traceEvents'] })).toBe(true)
  })

  it('does not treat unrelated socket flags as event debug', () => {
    expect(shouldTraceSimpleEventDispatch({ ...OFF, childSocketFlags: ['debugRtsp'] })).toBe(false)
    expect(shouldTraceSimpleEventDispatch({ ...OFF, hubSocketFlags: ['traceTalk'] })).toBe(false)
  })
})

describe('ReolinkHubSession.routeSimpleEvent traces before dispatch', () => {
  it('logs on the hub logger before calling the child handler', () => {
    const body = sliceMethodBody(hubSource, 'routeSimpleEvent(event: ReolinkSimpleEvent)')
    expect(body).toContain('shouldTraceSimpleEventDispatch')
    const logIdx = body.indexOf('Reolink hub: simpleEvent dispatch')
    const handleIdx = body.indexOf('child.handleSimpleEvent')
    expect(logIdx).toBeGreaterThan(-1)
    expect(handleIdx).toBeGreaterThan(-1)
    expect(logIdx).toBeLessThan(handleIdx)
  })
})

describe('ReolinkHubSession.routeSimpleEvent hands the child its motion sensor', () => {
  it('takes MD/PIR before the async child lookup and passes it to the child', () => {
    const body = sliceMethodBody(hubSource, 'routeSimpleEvent(event: ReolinkSimpleEvent)')
    const takeIdx = body.indexOf('this.#motionSensors.take(channel)')
    const lookupIdx = body.indexOf('this.#deps.children()')
    expect(takeIdx).toBeGreaterThan(-1)
    expect(takeIdx).toBeLessThan(lookupIdx)
    expect(body).toContain('child.handleSimpleEvent(event, motionSensor)')
  })

  it('observes the raw client event ahead of the API’s own mapping', () => {
    expect(hubSource).toContain("api.client.prependListener('event', this.#rawEventBound)")
  })
})
