import { describe, expect, it } from 'vitest'
import {
  BUS_METHODS,
  findAddonViolations,
  findCapViolations,
  methodNamesOf,
} from '../check-broker-cap-is-bus-only.js'

function capWith(methods: readonly string[]): string {
  const body = methods.map((m) => `    ${m}: method(In, Out),`).join('\n')
  return `export const brokerCapability = {\n  name: 'broker',\n  methods: {\n${body}\n  },\n} as const`
}

describe('check-broker-cap-is-bus-only', () => {
  it('reads the method names under methods', () => {
    expect(methodNamesOf(capWith(['publish', 'getStatus']))).toEqual(['publish', 'getStatus'])
  })

  it('passes a cap that declares exactly the bus', () => {
    expect(findCapViolations(capWith(BUS_METHODS), 'export {}')).toEqual([])
  })

  it('refuses a cap that brings a CRUD method back', () => {
    const found = findCapViolations(capWith([...BUS_METHODS, 'list']), 'export {}')
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('expected exactly the bus')
  })

  it('refuses a cap that lost a bus method', () => {
    expect(findCapViolations(capWith(BUS_METHODS.slice(1)), 'export {}')).toHaveLength(1)
  })

  it('refuses a retired broker row type exported from the types index', () => {
    const found = findCapViolations(capWith(BUS_METHODS), 'export type { BrokerInfo } from "./x"')
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('retired broker row type')
  })

  it('refuses a bare re-export line of the retired type, and spares the mqtt cap alias', () => {
    expect(
      findCapViolations(capWith(BUS_METHODS), 'export type {\n  BrokerInfo,\n} from "./x"'),
    ).toHaveLength(1)
    const alias = 'export type {\n  BrokerInfo as MqttBrokerInfo,\n} from "./mqtt-broker.cap.js"'
    expect(findCapViolations(capWith(BUS_METHODS), alias)).toEqual([])
  })

  it('refuses an addon that implements listProviders', () => {
    const found = findAddonViolations([
      {
        path: 'packages/addon-x/src/a.ts',
        source: 'return { listProviders: async () => [] }',
      },
    ])
    expect(found).toHaveLength(1)
  })

  it('refuses a signIn outside an instance kind and accepts one inside', () => {
    expect(
      findAddonViolations([{ path: 'a.ts', source: 'const d = { signIn: { basePath: "/x" } }' }]),
    ).toHaveLength(1)
    expect(
      findAddonViolations([
        {
          path: 'a.ts',
          source: "kind: { id: 'a', functionCap: 'broker', signIn: { basePath: '/x' } }",
        },
      ]),
    ).toEqual([])
  })
})
