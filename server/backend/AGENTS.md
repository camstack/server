# AGENTS.md — backend

Package-level instructions for any coding agent. The repository-wide rules
are in the root `AGENTS.md`; `CLAUDE.md` beside this file is a one-line
`@AGENTS.md` import for Claude Code. Edit only this file.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed `*.cap.ts`; picking a provider → `camstack-capability` (`.claude/skills/camstack-capability/SKILL.md`)
- A change to `server/backend`, `system`, `types` or `sdk`: test, build, ship → `camstack-server-change` (`.claude/skills/camstack-server-change/SKILL.md`)
- A password / token / key, or a credential for a child process → `camstack-secrets` (`.claude/skills/camstack-secrets/SKILL.md`)
- Something is wrong on a running node: logs, API, where work ran → `camstack-diagnose` (`.claude/skills/camstack-diagnose/SKILL.md`)
<!-- camstack-skills-pointer:end -->
