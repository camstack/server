import { describe, expect, it } from 'vitest'
import {
  capViolations,
  collectionCapsOf,
  judge,
  NOT_AN_INSTANCE_REF_SITES,
  siteViolations,
  type SourceFile,
} from '../check-instance-refs-use-link-primitive.js'

function file(path: string, source: string): SourceFile {
  return { path, source }
}

const IMPORT = `import { declareLinkKind } from '@camstack/types'\n`

describe('check-instance-refs-use-link-primitive', () => {
  it('rule 1: a broker-select field type is a violation, anywhere', () => {
    const found = siteViolations([
      file('packages/addon-x/src/form.ts', `{ type: 'broker-select', key: 'k' }`),
    ])
    expect(found.map((v) => v.id)).toEqual(['broker-select:packages/addon-x/src/form.ts'])
    expect(
      siteViolations([file('packages/addon-x/src/form.ts', `{ type: 'instance-select' }`)]),
    ).toEqual([])
  })

  it('rule 2: an instance reference key outside the primitive is a violation, inside it is not', () => {
    const body = `const S = z.object({ mqttBrokerId: z.string(), calendarIds: z.array(z.string()) })`
    const bare = siteViolations([file('packages/addon-mqtt/src/inst.ts', body)])
    expect(bare.map((v) => v.id).toSorted()).toEqual([
      'addon-mqtt:inst.ts:calendarIds',
      'addon-mqtt:inst.ts:mqttBrokerId',
    ])
    expect(siteViolations([file('packages/addon-mqtt/src/inst.ts', IMPORT + body)])).toEqual([])
    const form = siteViolations([file('packages/addon-mqtt/src/f.ts', `{ key: 'smtpInstanceId' }`)])
    expect(form.map((v) => v.id)).toEqual(['addon-mqtt:f.ts:smtpInstanceId'])
  })

  it('rule 2 skips the admin UI, device classes, custom actions and non-reference keys', () => {
    const body = `x = z.object({ brokerId: z.string() })`
    expect(siteViolations([file('packages/addon-admin-ui/src/a.ts', body)])).toEqual([])
    expect(siteViolations([file('packages/addon-x/src/devices/d.ts', body)])).toEqual([])
    expect(siteViolations([file('packages/addon-x/src/custom-actions.ts', body)])).toEqual([])
    expect(
      siteViolations([
        file('packages/addon-x/src/t.ts', `x = z.object({ customAccountId: z.string() })`),
      ]),
    ).toEqual([])
    expect(
      siteViolations([file('packages/addon-x/src/t.ts', `x = z.object({ name: z.string() })`)]),
    ).toEqual([])
  })

  it('rule 2 accepts linkFieldDescriptor as the primitive too', () => {
    const src = `import { linkFieldDescriptor } from '@camstack/types'\n{ key: 'smtpInstanceId' }`
    expect(siteViolations([file('packages/addon-x/src/e.ts', src)])).toEqual([])
  })

  it('rule 2 exempts a named non-link site, and only that file and key', () => {
    expect(NOT_AN_INSTANCE_REF_SITES.size).toBe(6)
    const body = `x = z.object({ accountId: z.string() })`
    expect(
      siteViolations([file('packages/addon-cloudflare/src/tunnel/cloudflare-actions.ts', body)]),
    ).toEqual([])
    // the same key in another file of the same addon is still a violation
    expect(
      siteViolations([file('packages/addon-cloudflare/src/tunnel/other.ts', body)]).map(
        (v) => v.id,
      ),
    ).toEqual(['addon-cloudflare:tunnel/other.ts:accountId'])
    expect(
      siteViolations([
        file(
          'packages/addon-terminal/src/terminal-camera-device.ts',
          `z.object({ instanceId: z.string() })`,
        ),
      ]),
    ).toEqual([])
  })

  it('exempts one file+key (reolink mailbox plumbing) but the same key elsewhere still counts', () => {
    const body = `z.object({ brokerId: z.string() })`
    expect(
      siteViolations([file('packages/addon-provider-reolink/src/email-push-bridge.ts', body)]),
    ).toEqual([])
    expect(
      siteViolations([file('packages/addon-provider-reolink/src/other.ts', body)]).map((v) => v.id),
    ).toEqual(['addon-provider-reolink:other.ts:brokerId'])
  })

  it('rule 3: the baseline shrinks only — a new site is fresh, an entry without a site is stale', () => {
    const found = siteViolations([
      file('packages/addon-x/src/a.ts', `z.object({ brokerId: z.string() })`),
    ])
    expect(judge(found, ['addon-x:a.ts:brokerId'])).toEqual({ fresh: [], stale: [] })
    expect(judge(found, []).fresh).toHaveLength(1)
    expect(judge([], ['addon-x:a.ts:brokerId']).stale).toEqual(['addon-x:a.ts:brokerId'])
  })

  it('rule 4: declareLinkKind names only collection caps that exist', () => {
    const caps = collectionCapsOf([
      `name: 'broker', mode: 'collection'`,
      `name: 'singleton-thing', mode: 'singleton'`,
    ])
    expect([...caps]).toEqual(['broker'])
    const ok = file(
      'packages/addon-x/src/k.ts',
      `declareLinkKind({ name: 'c', links: { brokerId: { cap: 'broker', kind: 'mqtt' } } })`,
    )
    expect(capViolations([ok], caps)).toEqual([])
    const bad = file(
      'packages/addon-x/src/k.ts',
      `declareLinkKind({ name: 'c', links: { a: { cap: 'brokr' }, b: { cap: 'singleton-thing' } } })`,
    )
    expect(capViolations([bad], caps).map((v) => v.id)).toEqual([
      'cap:packages/addon-x/src/k.ts:brokr',
      'cap:packages/addon-x/src/k.ts:singleton-thing',
    ])
  })
})
