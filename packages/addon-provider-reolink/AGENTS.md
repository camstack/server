# packages/addon-provider-reolink

Reolink integration over Baichuan / BCUDP plus CGI. Standalone cameras, NVRs, and
NVR-adopted children.

Battery cameras are the hard part, and everything below was learned by getting it
wrong first. Full narrative: the private session log (`../planning/sessions/`).

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Package notes — read before changing this package

The traps and rules for this package live in
[`docs/addons/addon-provider-reolink.md`](../../docs/addons/addon-provider-reolink.md) (kept out of this
file so root + package `AGENTS.md` fit the 32 KiB Codex reads). Sections:

- Battery cameras: the model
- The pieces, and why each exists
- Standalone vs under an NVR
- Passive contact, and where a standalone camera gets none
- When you change any of this
- Clip stills: two traps the queue's own rules do not cover
