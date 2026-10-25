# AGENTS.md — addon-export-google

Google Home / Google Assistant export. Read this before changing anything here;
the traps below are not visible from the code.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Package notes — read before changing this package

The traps and rules for this package live in
[`docs/addons/addon-export-google.md`](../../docs/addons/addon-export-google.md) (kept out of this
file so root + package `AGENTS.md` fit the 32 KiB Codex reads). Sections:

- What is built, and what is not
- `publicHubUrl` — the one value an operator owns
- The one rule that shapes the whole addon
- Traps
- Credentials — read before adding a settings field
- Operator setup (all on Google's side)
- Shipping
