/**
 * The judgement of `check-extension-slots.ts` (D648), as a pure function over
 * facts the script gathers — so every rule can be proven red on a fixture.
 *
 * The rules, each a declaration or a literal, never a judgement call:
 *
 *  1. Every slot id is unique across caps.
 *  2. Every declared slot has EXACTLY ONE `defineExtensionSlotProvider('<id>'`,
 *     in exactly one package, inside an addon whose manifest declares
 *     `device-extension`. No owner fails; two owners fail; an owner of an
 *     undeclared id fails.
 *  3. `generated/extension-slots.ts` is what the declarations render to.
 *  4. `device-extension.cap.ts` declares no store-shaped method — the
 *     contract is a view, never a second store (D62, D3).
 *  5. A slot's value schema carries no `slot` key (codegen adds it), and a
 *     slot has host device types, declared or inherited from its cap.
 *
 * There is no shape rule: a slot is an association. D648's `graft` shape
 * (and its rule "a graft projects its deviceNative declaring cap") was retired
 * by D663 — a host that gains a capability from other devices is a
 * composition.
 */

/** One declared slot, as the guard sees it. */
export interface SlotFact {
  readonly id: string
  readonly declaringCap: string
  readonly hasHostDeviceTypes: boolean
  readonly valueHasSlotKey: boolean
}

/** One `defineExtensionSlotProvider('<id>'` call site. */
export interface OwnerFact {
  readonly slotId: string
  /** Repo-relative path of the file. */
  readonly file: string
  /** The package directory the file belongs to (`packages/system`). */
  readonly packageDir: string
  /** The manifest addon whose entry directory contains the file, or null. */
  readonly addonId: string | null
  /** Whether that addon's manifest declares `device-extension`. */
  readonly addonDeclaresContract: boolean
}

export interface ExtensionSlotFacts {
  readonly slots: readonly SlotFact[]
  readonly owners: readonly OwnerFact[]
  readonly contractMethods: readonly string[]
  /** Null when the generated module is in sync; otherwise why it is not. */
  readonly generatedDrift: string | null
}

/** A method name that reads like a store, not a view. */
const STORE_SHAPED_METHOD = /^(get\w*Config|save\w*|set\w*Config|write\w*|persist\w*)$/

export function checkExtensionSlotFacts(facts: ExtensionSlotFacts): readonly string[] {
  const failures: string[] = []

  const byId = new Map<string, SlotFact[]>()
  for (const slot of facts.slots) byId.set(slot.id, [...(byId.get(slot.id) ?? []), slot])
  for (const [id, slots] of byId) {
    if (slots.length > 1) {
      failures.push(
        `slot "${id}" is declared by ${slots.length} caps (${slots.map((s) => s.declaringCap).join(', ')}) — a slot id is unique across caps`,
      )
    }
  }

  for (const slot of facts.slots) {
    if (slot.valueHasSlotKey) {
      failures.push(
        `slot "${slot.id}": its value schema has a "slot" key — codegen adds the discriminant; the value must not carry one`,
      )
    }
    if (!slot.hasHostDeviceTypes) {
      failures.push(
        `slot "${slot.id}": no host device types — declare hostDeviceTypes (its cap "${slot.declaringCap}" declares no deviceTypes)`,
      )
    }
  }

  const declared = new Set(facts.slots.map((s) => s.id))
  for (const id of declared) {
    const owners = facts.owners.filter((o) => o.slotId === id)
    if (owners.length === 0) {
      failures.push(
        `slot "${id}" has no owner — no defineExtensionSlotProvider('${id}', …) anywhere; a slot nobody serves is a card that can never load`,
      )
      continue
    }
    if (owners.length > 1) {
      failures.push(
        `slot "${id}" has ${owners.length} owners (${owners.map((o) => o.file).join(', ')}) — exactly one addon owns a slot's store`,
      )
    }
    for (const owner of owners) {
      if (owner.addonId === null) {
        failures.push(
          `slot "${id}": ${owner.file} is inside no manifest addon's entry directory of ${owner.packageDir}`,
        )
      } else if (!owner.addonDeclaresContract) {
        failures.push(
          `slot "${id}": addon "${owner.addonId}" (${owner.packageDir}) serves it but its manifest does not declare device-extension`,
        )
      }
    }
  }
  for (const owner of facts.owners) {
    if (!declared.has(owner.slotId)) {
      failures.push(
        `${owner.file}: defineExtensionSlotProvider('${owner.slotId}', …) names a slot no cap declares`,
      )
    }
  }

  if (facts.generatedDrift !== null) failures.push(facts.generatedDrift)

  for (const method of facts.contractMethods) {
    if (STORE_SHAPED_METHOD.test(method)) {
      failures.push(
        `device-extension.${method} reads like a store — the contract is a view over each owner's store and persists nothing (D62, D3)`,
      )
    }
  }

  return failures
}
