#!/usr/bin/env tsx
/**
 * Codegen: fold every capability's `extensionSlots` into
 * `packages/types/src/generated/extension-slots.ts` (D648) — the slot-id enum,
 * the `EXTENSION_SLOTS` table, the discriminated union of slot values and the
 * host device types `device-extension` is offered on.
 *
 * Adding a kind is a descriptor in the owning `*.cap.ts`, a
 * `defineExtensionSlotProvider('<id>', …)` in the owning addon, and
 * `npm run codegen`. `scripts/check-extension-slots.ts` checks the rest.
 *
 * Run manually: npx tsx scripts/generate-extension-slots.ts
 */
import * as path from 'node:path'
import { writeIfChanged } from './codegen-write.ts'
import { EXTENSION_SLOTS_OUTPUT, REPO_ROOT, loadCapModules } from './extension-slots-load.ts'
import { collectExtensionSlots, renderExtensionSlotsModule } from './extension-slots-model.ts'

async function main(): Promise<void> {
  const slots = collectExtensionSlots(await loadCapModules())
  writeIfChanged(EXTENSION_SLOTS_OUTPUT, renderExtensionSlotsModule(slots))
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${slots.length} extension slot(s) → ${path.relative(REPO_ROOT, EXTENSION_SLOTS_OUTPUT)}`,
  )
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
