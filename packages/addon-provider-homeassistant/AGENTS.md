# packages/addon-provider-homeassistant

**One bundle, two addons, two processes.**

| Manifest id | Entry | What it does |
| --- | --- | --- |
| `provider-homeassistant` | `src/addon.ts` | IMPORT — adopts HA devices into CamStack over the authenticated WebSocket. Owns the `broker` cap. |
| `homeassistant-export` | `src/ha-export/ha-export.addon.ts` | EXPORT — pushes CamStack entities INTO Home Assistant over HTTP. |

They ship together so the HA URL and token are not duplicated, and they run
apart so a defect in export cannot respawn the runner that owns the devices
([D29](../../docs/decisions/adr-0029.md)). **They do not import each other**, in
either direction: export reads the connection through the `broker` cap via
`ctx.api`, like any other addon would.

Contract for the export half:
(planning repo: superpowers/specs/2026-08-04-ha-native-export-design.md). Read it before
changing the entity map or the transport.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Package notes — read before changing this package

The traps and rules for this package live in
[`docs/addons/addon-provider-homeassistant.md`](../../docs/addons/addon-provider-homeassistant.md) (kept out of this
file so root + package `AGENTS.md` fit the 32 KiB Codex reads). Sections:

- Four things that are a wire format
- Every value has a listener. Here is which one.
- Rules that cost real time when broken
- Membership
- Retired
