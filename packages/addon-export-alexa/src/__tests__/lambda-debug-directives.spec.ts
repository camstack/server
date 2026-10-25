/**
 * `DEBUG_DIRECTIVES=1` — a temporary diagnostic on the skill Lambda: one
 * `directive_trace` line per Smart Home directive, carrying what Alexa asked
 * (namespace / name / endpointId / payloadVersion / payload keys) and what the
 * skill answered (event namespace / name, the ErrorResponse type and message,
 * and for a StateReport each context property's namespace / name / value
 * kind). It must never carry a bearer token, and it is silent without the flag.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Handler = (event: unknown) => Promise<Record<string, unknown>>
const lambda = require('../../lambda-template/index.js') as {
  createHandler(deps: Record<string, unknown>): Handler
}

const HUB = 'https://hub.example.test'
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const BEARER = `${b64({ alg: 'none' })}.${b64({ hubUrl: HUB, sub: 'u1' })}.sig`

function hubReplying(body: unknown) {
  const text = JSON.stringify(body)
  return async () => ({
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => 'application/json' },
  })
}

function harness(env: Record<string, string>, hubBody: unknown) {
  const lines: Array<{ msg: string; data: unknown }> = []
  const record = (msg: unknown, data?: unknown) => lines.push({ msg: String(msg), data })
  const handler = lambda.createHandler({
    env,
    fetch: hubReplying(hubBody),
    store: null,
    secrets: { lwa: async () => null, skill: async () => null, invalidate: () => {} },
    now: () => 1_800_000_000_000,
    log: { info: record, warn: record, error: record },
  })
  return { handler, lines }
}

function reportState(endpointId: string) {
  return {
    directive: {
      header: {
        namespace: 'Alexa',
        name: 'ReportState',
        messageId: 'm1',
        correlationToken: 'corr',
        payloadVersion: '3',
      },
      endpoint: { endpointId, scope: { type: 'BearerToken', token: BEARER } },
      payload: {},
    },
  }
}

const STATE_REPORT = {
  event: {
    header: { namespace: 'Alexa', name: 'StateReport', messageId: 'm1', payloadVersion: '3' },
    endpoint: { endpointId: '101' },
    payload: {},
  },
  context: {
    properties: [
      { namespace: 'Alexa.MotionSensor', name: 'detectionState', value: 'DETECTED' },
      { namespace: 'Alexa.EndpointHealth', name: 'connectivity', value: { value: 'OK' } },
    ],
  },
}

describe('DEBUG_DIRECTIVES trace', () => {
  it('logs the directive and the StateReport property shape when the flag is on', async () => {
    const { handler, lines } = harness({ DEBUG_DIRECTIVES: '1' }, STATE_REPORT)
    await handler(reportState('101'))
    const trace = lines.filter((l) => l.msg === 'directive_trace')
    expect(trace).toHaveLength(1)
    expect(trace[0]?.data).toMatchObject({
      directive: {
        namespace: 'Alexa',
        name: 'ReportState',
        endpointId: '101',
        payloadVersion: '3',
      },
      response: {
        namespace: 'Alexa',
        name: 'StateReport',
        properties: [
          'Alexa.MotionSensor.detectionState=DETECTED',
          'Alexa.EndpointHealth.connectivity={value:OK}',
        ],
      },
    })
  })

  it('logs the ErrorResponse type and message', async () => {
    const { handler, lines } = harness(
      { DEBUG_DIRECTIVES: '1' },
      {
        event: {
          header: { namespace: 'Alexa', name: 'ErrorResponse', messageId: 'm1' },
          payload: { type: 'ENDPOINT_UNREACHABLE', message: 'camera offline' },
        },
      },
    )
    await handler(reportState('592'))
    const trace = lines.find((l) => l.msg === 'directive_trace')
    expect(trace?.data).toMatchObject({
      response: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        errorType: 'ENDPOINT_UNREACHABLE',
        errorMessage: 'camera offline',
      },
    })
  })

  it('never carries the bearer token', async () => {
    const { handler, lines } = harness({ DEBUG_DIRECTIVES: '1' }, STATE_REPORT)
    await handler(reportState('101'))
    expect(JSON.stringify(lines)).not.toContain(BEARER)
    expect(JSON.stringify(lines)).not.toContain('"token"')
  })

  it('is silent without the flag', async () => {
    const { handler, lines } = harness({}, STATE_REPORT)
    await handler(reportState('101'))
    expect(lines.filter((l) => l.msg === 'directive_trace')).toHaveLength(0)
  })
})
