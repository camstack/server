# packages/addon-export-alexa

Alexa Export. Alexa Cloud → a Lambda → `POST /addon/export-alexa/directive`
on this hub. Account linking is the core OAuth server's
(`/api/oauth2/authorize?integration=export-alexa`); this addon only declares the
descriptor (`oauth-integration.ts`).

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Package notes — read before changing this package

The traps and rules for this package live in
[`docs/addons/addon-export-alexa.md`](../../docs/addons/addon-export-alexa.md) (kept out of this
file so root + package `AGENTS.md` fit the 32 KiB Codex reads). Sections:

- The link has TWO halves, and they fail in opposite directions
- The hub holds NO Amazon client secret (D753)
- Operator procedures — everything account- or token-related
- Who a link acts for (D767)
- What may be declared (D769)
- What each endpoint carries
- Secrets on read surfaces (D768)
- When you change any of this
