# AGENTS.md — addon-ai

The `llm` collection provider (hub only) plus the per-node `llm-runtime` managed
llama.cpp executor. The hub/agent split lives in `assembly.ts`; `addon.ts` only
gathers context and wires the seams.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Package notes — read before changing this package

The traps and rules for this package live in
[`docs/addons/addon-ai.md`](../../docs/addons/addon-ai.md) (kept out of this
file so root + package `AGENTS.md` fit the 32 KiB Codex reads). Sections:

- The hub/agent split decides what exists
- The test chat is a DATA-PLANE STREAM, not a cap method and not a custom action
- Rules for anything that consumes media here
- Testing
- Apple Foundation Models (`apple-foundation`) — [D639](../../docs/decisions/adr-0639-apple-foundation-models-runs-as-a-supervised-child-behind-llm-runtime.md)
