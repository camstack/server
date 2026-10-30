import {
  MutationGate,
  type ConnectOutcome,
  type HubClient,
  type HubHttpMethod,
} from '@camstack/develop'
import type { McpContext } from '../mcp/context.js'

export interface RecordedCall {
  readonly method: HubHttpMethod
  readonly path: string
  readonly input: unknown
}

/** A path answers with a value, with a function of its input, or throws an Error. */
export type Answer = unknown

export interface FakeHub {
  readonly ctx: McpContext
  readonly calls: RecordedCall[]
}

export function fakeHub(
  answers: { readonly [path: string]: Answer },
  tier: 'admin' | 'protected' = 'admin',
): FakeHub {
  const calls: RecordedCall[] = []
  const client: HubClient = {
    async call(method, path, input) {
      calls.push({ method, path, input })
      if (!(path in answers)) throw new Error(`no fake answer for ${path}`)
      const answer = answers[path]
      if (answer instanceof Error) throw answer
      if (typeof answer === 'function') return answer(input)
      return answer
    },
  }
  const outcome: ConnectOutcome = {
    ok: true,
    connection: {
      server: 'https://hub.example.test',
      token: 'tok-should-never-appear-in-output',
      tier,
      source: 'session',
      tls: {},
      client,
      adminHint: tier === 'admin' ? null : 'log in as admin',
      loginCommand: 'camstack login',
    },
  }
  return {
    calls,
    ctx: {
      cliVersion: '9.9.9',
      hub: async () => outcome,
      gate: new MutationGate({ allowMutations: false }),
      fetch: async () => new Response('{}'),
    },
  }
}

export function noSessionContext(): McpContext {
  return {
    cliVersion: '9.9.9',
    hub: async () => ({
      ok: false,
      reason: 'no-session',
      message: 'no usable hub session',
      action: 'run `camstack login <host>` in a terminal',
    }),
    gate: new MutationGate({ allowMutations: false }),
    fetch: async () => new Response('{}'),
  }
}
