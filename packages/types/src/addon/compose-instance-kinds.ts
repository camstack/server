/**
 * `composeInstanceKinds` — ONE `integration-instances` provider over SEVERAL record kinds (D1013).
 *
 * An addon registers one `integration-instances` provider (the collection is keyed by addon id), so
 * an addon that configures two things — an account and the integrations that use it, a relay and
 * a mailbox — composes one provider per kind into one. Each part names the function capability it
 * serves; a page section is the kinds whose `functionCap` it asks for.
 *
 * Routing: a call that names an id goes to the part that holds the id, a create or a form without
 * an id goes to the part of the named `kind` (refused without one when there are several).
 */
import type {
  IIntegrationInstancesProvider,
  IntegrationInstance,
  IntegrationInstanceDescription,
  IntegrationInstanceKind,
} from '../capabilities/integration-instances.cap.js'

/** One record kind of the composed provider and the provider that serves it. */
export interface InstanceKindPart {
  readonly kind: IntegrationInstanceKind
  readonly provider: IIntegrationInstancesProvider
}

/** No part holds the id a call named. */
export class UnknownInstanceError extends Error {
  constructor(readonly instanceId: string) {
    super(`Unknown instance '${instanceId}'`)
    this.name = 'UnknownInstanceError'
  }
}

/** A create or a form named no kind, or a kind no part serves. */
export class UnknownInstanceKindError extends Error {
  constructor(readonly kindId: string | undefined) {
    super(
      kindId === undefined
        ? 'This provider has several kinds: name one'
        : `Unknown instance kind '${kindId}'`,
    )
    this.name = 'UnknownInstanceKindError'
  }
}

export function composeInstanceKinds(
  parts: readonly InstanceKindPart[],
  base: Omit<IntegrationInstanceDescription, 'kinds'>,
): IIntegrationInstancesProvider {
  const byKind = (kindId: string | undefined): InstanceKindPart => {
    if (kindId === undefined) {
      const only = parts.length === 1 ? parts[0] : undefined
      if (only === undefined) throw new UnknownInstanceKindError(undefined)
      return only
    }
    const part = parts.find((candidate) => candidate.kind.id === kindId)
    if (part === undefined) throw new UnknownInstanceKindError(kindId)
    return part
  }

  /**
   * The part a DRAFT test runs on. A named kind is that kind; an unnamed one is the provider's only
   * testable kind. Several testable kinds and none named is a typed refusal that lists them, never a throw.
   */
  const draftPart = (kindId: string | undefined): InstanceKindPart | { readonly error: string } => {
    if (kindId !== undefined) {
      const named = parts.find((candidate) => candidate.kind.id === kindId)
      return named ?? { error: `Unknown instance kind '${kindId}'` }
    }
    const testable = parts.filter((part) => part.kind.canTest !== false)
    const only = testable.length === 1 ? testable[0] : parts.length === 1 ? parts[0] : undefined
    if (only !== undefined) return only
    const names = (testable.length > 0 ? testable : parts).map((part) => part.kind.id).join(', ')
    return { error: `This provider has several kinds: name one of ${names}` }
  }

  const holderOf = async (id: string): Promise<InstanceKindPart> => {
    for (const part of parts) {
      if ((await part.provider.getInstance({ id })) !== null) return part
    }
    throw new UnknownInstanceError(id)
  }

  const tagged = (part: InstanceKindPart, instance: IntegrationInstance): IntegrationInstance => ({
    ...instance,
    kind: part.kind.id,
  })

  return {
    describe: async () => {
      // Every part answers the links its own kind declares; the composed provider answers them all.
      const links = (
        await Promise.all(parts.map(async (part) => (await part.provider.describe()).links ?? []))
      ).flat()
      return {
        ...base,
        kinds: parts.map((part) => part.kind),
        ...(links.length > 0 ? { links } : {}),
      }
    },
    instanceFormSchema: async ({ id, kind }) => {
      const part = id === null ? byKind(kind) : await holderOf(id)
      return part.provider.instanceFormSchema({ id })
    },
    listInstances: async () => {
      const lists = await Promise.all(
        parts.map(async (part) =>
          (await part.provider.listInstances()).map((instance) => tagged(part, instance)),
        ),
      )
      return lists.flat()
    },
    getInstance: async ({ id }) => {
      for (const part of parts) {
        const found = await part.provider.getInstance({ id })
        if (found !== null) return tagged(part, found)
      }
      return null
    },
    createInstance: async (input) => byKind(input.kind).provider.createInstance(input),
    updateInstance: async (input) => (await holderOf(input.id)).provider.updateInstance(input),
    setInstanceEnabled: async (input) =>
      (await holderOf(input.id)).provider.setInstanceEnabled(input),
    deleteInstance: async (input) => (await holderOf(input.id)).provider.deleteInstance(input),
    testInstance: async (input) => {
      const resolved = input.id === null ? draftPart(input.kind) : await holderOf(input.id)
      if ('error' in resolved) {
        return { success: false, status: 'inconclusive', error: resolved.error }
      }
      const test = resolved.provider.testInstance
      if (test === undefined) {
        return {
          success: false,
          status: 'inconclusive',
          error: 'This kind cannot be tested',
        }
      }
      return test(input)
    },
  }
}
