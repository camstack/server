#!/usr/bin/env tsx
/**
 * GUARD: every device type has a hero look and a hero layout, and every look
 * is complete (D1023).
 *
 * The tables are `satisfies Record<DeviceType, …>` at compile time; this guard
 * re-checks at runtime what a type cannot: each declared look names ALL eight
 * states, every icon is in the icon catalog, every tone / background /
 * animation is a known token, every row a layout names exists, and a state
 * resolves for every (role, type) pair. A new DeviceType or DeviceRole with no
 * look fails here before it renders as a bare default.
 *
 *   npx tsx scripts/check-hero-look-exhaustive.ts
 */
import { DeviceRole, DeviceType } from '../packages/types/src/device/device-type.js'
import { isIconKey } from '../packages/types/src/device/icon-catalog.js'
import {
  HERO_LAYOUT_BY_TYPE,
  HERO_LAYOUT_DEFAULT,
  resolveHeroLayout,
} from '../packages/types/src/device/hero/hero-layout.js'
import { HERO_SCENES, resolveHeroSceneId } from '../packages/types/src/device/hero/hero-scene.js'
import { allHeroLooks, resolveHeroLook } from '../packages/types/src/device/hero/hero-look.js'
import { HERO_ROW_IDS } from '../packages/types/src/device/hero/hero-model.js'
import {
  HERO_ANIMATIONS,
  HERO_BACKGROUNDS,
  HERO_STATES,
  HERO_TONES,
} from '../packages/types/src/device/hero/hero-state.js'

const problems: string[] = []

for (const look of allHeroLooks()) {
  for (const state of HERO_STATES) {
    const l = look[state]
    if (l === undefined) {
      problems.push(`a look is missing the state "${state}"`)
      continue
    }
    if (!isIconKey(l.icon))
      problems.push(`state "${state}": icon "${String(l.icon)}" is not in the icon catalog`)
    if (!HERO_TONES.includes(l.tone)) problems.push(`state "${state}": unknown tone "${l.tone}"`)
    if (!HERO_BACKGROUNDS.includes(l.background))
      problems.push(`state "${state}": unknown background "${l.background}"`)
    if (!HERO_ANIMATIONS.includes(l.animation))
      problems.push(`state "${state}": unknown animation "${l.animation}"`)
  }
}

for (const type of Object.values(DeviceType)) {
  if (HERO_LAYOUT_BY_TYPE[type] === undefined)
    problems.push(`device type "${type}" has no hero layout`)
  for (const role of [null, ...Object.values(DeviceRole)]) {
    for (const state of HERO_STATES) {
      if (resolveHeroLook(role, type, state) === undefined) {
        problems.push(
          `no look resolves for type "${type}", role "${String(role)}", state "${state}"`,
        )
      }
    }
  }
}

for (const layout of [
  HERO_LAYOUT_DEFAULT,
  ...Object.values(HERO_LAYOUT_BY_TYPE),
  resolveHeroLayout('no-such-type'),
]) {
  for (const row of layout.rows) {
    if (!HERO_ROW_IDS.includes(row)) problems.push(`a layout names the unknown row "${row}"`)
  }
}

for (const type of Object.values(DeviceType)) {
  for (const role of [null, ...Object.values(DeviceRole)]) {
    const scene = resolveHeroSceneId(role, type)
    if (!HERO_SCENES.includes(scene)) {
      problems.push(`no scene resolves for type "${type}", role "${String(role)}"`)
    }
  }
}

if (problems.length > 0) {
  console.error(`check-hero-look-exhaustive: ${problems.length} problem(s)`)
  for (const p of problems.slice(0, 40)) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(
  'check-hero-look-exhaustive: every type and role resolves a complete look, a layout and a scene',
)
