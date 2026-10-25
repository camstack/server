# AGENTS.md — addon-provider-hikvision

Traps inside this package. Everything general is in the root `AGENTS.md`.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Package notes — read before changing this package

The traps and rules for this package live in
[`docs/addons/addon-provider-hikvision.md`](../../docs/addons/addon-provider-hikvision.md) (kept out of this
file so root + package `AGENTS.md` fit the 32 KiB Codex reads). Sections:

- The camera has ONE playback slot, and it does not forgive
- A played-out replay goes QUIET — it does not close
- A replay is paced at 1x, and that decides the rate ladder
- A 1x source needs a CUSHION, and the broker owns it
- A still NEVER spends the camera's playback session
- A clip stream with SOUND needs `-max_interleave_delta`
- ffmpeg comes from `ctx.deps.ensureFfmpeg()`
- Credentials never reach an argv
- Three things `ContentMgmt` says that are not true
- The track list is not uniform across this fleet
- `SETUP` the MEDIA control, never the session one
