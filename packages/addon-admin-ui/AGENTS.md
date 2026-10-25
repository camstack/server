# AGENTS.md — addon-admin-ui

Package-level instructions for any coding agent. The repository-wide rules
are in the root `AGENTS.md`; `CLAUDE.md` beside this file is a one-line
`@AGENTS.md` import for Claude Code. Edit only this file.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## UI work

<!-- camstack-ui-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
**This package is the admin UI.** Before any UI change load `camstack-ui` (`.claude/skills/camstack-ui/SKILL.md`), then `camstack-ui-admin` (`.claude/skills/camstack-ui-admin/SKILL.md`). Page patterns: `docs/ui/admin-patterns.md`.

- Search before building: `npm run ui:find -- "<need>"`, `npm run ui:show -- <Name>`, `npm run ui:tokens`.
- Library components and theme tokens only: no hex, no palette classes (`bg-red-500`), no colour or spacing in `style=`.
- Rules: `docs/ui/README.md` (conventions, need → component, admin patterns, viewer, anti-patterns).
- Done = the skill’s done-gate: `npm run ui:check -- <files>` with 0 new findings, plus `npm run ui:shots` before/after (dark + light, desktop 1440×900 + phone 390×844).
- After `ui:shots`: **Read the PNG files** under `scratchpad/ui-shots/<label>/` (Cursor `Read` accepts images) so before/after appear in the transcript — do not stop at `report.md` alone. Any agent / harness, not only Claude Code.
<!-- camstack-ui-pointer:end -->
