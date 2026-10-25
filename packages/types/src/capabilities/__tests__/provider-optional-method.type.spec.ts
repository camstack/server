/**
 * `providerOptional` — a COLLECTION cap method a source may legitimately not
 * serve, and the type says so instead of forcing a stub.
 *
 * `videoclips` is the cap that needed it. Its sources are peers, none of them
 * privileged, and they do genuinely different things: the recorder's
 * `analytics` source is a WINDOW over footage with no file behind it, an HKSV
 * shelf is a store of fragments, and only a vendor's onboard catalog has a
 * file it can hand over as bytes. Making `readClipBytes` required would force
 * every one of them to write a throwing stub — and a stub that throws is
 * indistinguishable, to a reader, from a method somebody forgot.
 *
 * The RUNTIME already treated absence as a first-class, NAMED case long before
 * the type did: `device-collection-dispatch.ts`'s `callSource` answers a
 * missing method with `NOT_IMPLEMENTED`, naming the cap, the source and the
 * method, and `isCollectionArrayMethod` lets a missing array method contribute
 * `[]` rather than failing the fan-out. This flag stops the type from
 * demanding what the framework never needed.
 */
import { describe, expect, it } from 'vitest'
import {
  type CapabilityDefinition,
  type InferProvider,
  method,
  optionalMethod,
} from '../capability-definition.js'
import { videoclipsCapability } from '../videoclips.cap.js'
import { z } from 'zod'

const demoCapability = {
  name: 'demo-optional',
  scope: 'device',
  mode: 'collection',
  methods: {
    listThings: method(z.object({ deviceId: z.number() }), z.array(z.string()).readonly(), {
      kind: 'query',
      auth: 'protected',
    }),
    readBytes: optionalMethod(z.object({ deviceId: z.number() }), z.string(), {
      kind: 'query',
      auth: 'protected',
    }),
  },
} as const satisfies CapabilityDefinition

type DemoProvider = InferProvider<typeof demoCapability>

describe('providerOptional', () => {
  it('lets a source omit the method and still satisfy the provider type', () => {
    const partial: DemoProvider = {
      listThings: async () => ['a'],
    }
    expect(partial.readBytes).toBeUndefined()
  })

  it('still types the method when a source DOES serve it', () => {
    const full: DemoProvider = {
      listThings: async () => [],
      readBytes: async ({ deviceId }) => String(deviceId),
    }
    expect(full.readBytes).toBeDefined()
  })

  it('keeps every other method required', () => {
    // @ts-expect-error `listThings` is not optional — omitting it is a bug,
    // not a source that does less.
    const broken: DemoProvider = { readBytes: async () => 'x' }
    expect(broken).toBeDefined()
  })

  it('marks videoclips.readClipBytes as source-optional', () => {
    // A source with no file behind its rows says so by NOT implementing it,
    // and the dispatcher names the absence.
    expect(videoclipsCapability.methods.readClipBytes.providerOptional).toBe(true)
    // …while every other videoclips method stays required.
    expect('providerOptional' in videoclipsCapability.methods.listClips).toBe(false)
  })
})
