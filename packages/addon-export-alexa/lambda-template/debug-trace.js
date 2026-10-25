'use strict'

/**
 * TEMPORARY diagnostic, on only with `DEBUG_DIRECTIVES=1`: one `directive_trace`
 * line per Smart Home directive — what Alexa asked and what the skill answered.
 *
 * Built from an allow-list of fields, never by dumping the event: the
 * directive's `scope.token` (the account's bearer) and the SDP bodies never
 * reach the log. StateReport property values are summarised (a short scalar,
 * or the object's keys and scalar values) — they are device states, not
 * credentials.
 */

const MAX_VALUE_CHARS = 60

function isEnabled(env) {
  return Boolean(env) && env.DEBUG_DIRECTIVES === '1'
}

function str(value) {
  return typeof value === 'string' ? value : undefined
}

function summariseValue(value) {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return String(value).slice(0, MAX_VALUE_CHARS)
  if (Array.isArray(value)) return `[array:${value.length}]`
  const parts = Object.keys(value).map((k) => {
    const v = value[k]
    return v !== null && typeof v === 'object' ? `${k}:{…}` : `${k}:${String(v)}`
  })
  return `{${parts.join(',')}}`.slice(0, MAX_VALUE_CHARS)
}

function payloadShape(payload) {
  if (!payload || typeof payload !== 'object') return undefined
  return Object.keys(payload)
    .filter((k) => k !== 'scope')
    .map((k) => {
      const v = payload[k]
      if (v && typeof v === 'object' && typeof v.value === 'string') {
        // RTC offers/answers: { format, value: <SDP> } — length only.
        return `${k}(${str(v.format) || 'object'},${v.value.length}b)`
      }
      return k
    })
}

function summariseDirective(event) {
  const d = (event && event.directive) || {}
  const h = d.header || {}
  const ep = d.endpoint || {}
  return {
    namespace: str(h.namespace),
    name: str(h.name),
    endpointId: str(ep.endpointId),
    payloadVersion: str(h.payloadVersion),
    payloadKeys: payloadShape(d.payload),
  }
}

function summariseResponse(body) {
  const ev = body && body.event
  if (!ev || !ev.header) return { kind: 'non-event' }
  const out = {
    namespace: str(ev.header.namespace),
    name: str(ev.header.name),
    endpointId: str(ev.endpoint && ev.endpoint.endpointId),
  }
  const payload = ev.payload || {}
  if (out.name === 'ErrorResponse') {
    out.errorType = str(payload.type)
    out.errorMessage = str(payload.message)
  } else {
    out.payloadKeys = payloadShape(payload)
  }
  const props =
    body.context && Array.isArray(body.context.properties) ? body.context.properties : null
  if (props) {
    out.properties = props.map(
      (p) => `${str(p && p.namespace)}.${str(p && p.name)}=${summariseValue(p && p.value)}`,
    )
  }
  return out
}

/** Log one trace line; never throws into the directive path. */
function traceDirective(deps, event, response, startedAt) {
  if (!isEnabled(deps.env)) return
  try {
    deps.log.info('directive_trace', {
      directive: summariseDirective(event),
      response: summariseResponse(response),
      ms: deps.now() - startedAt,
    })
  } catch {
    // diagnostics only
  }
}

module.exports = { traceDirective, summariseDirective, summariseResponse }
