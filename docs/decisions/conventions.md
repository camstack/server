# Decision records

One file per decision. See **[index.md](index.md)** for the list — that page is
generated from these files' frontmatter, so it is never out of date.

## Numbering, and why it looks odd

The numbers are not new. `D2`, `D9`, `D14` and friends appear in **~500 code
comments** across `packages/system` and `packages/types` — they were the
shorthand of an earlier "base-layer rework" series. The ADR ids deliberately
reuse them (`(D9)` in a comment → `adr-0009.md`) so that vocabulary keeps
working instead of being replaced by a second, competing one.

Consequences of that choice, stated plainly:

- **Some numbers are missing.** `D1` and `D7` are referenced too thinly to
  reconstruct honestly, so they have no record rather than an invented one.
  `D10` in code comments means "the Moleculer-native realisation of the event
  bus" — that is [D8](adr-0008.md)'s transport, not a separate decision, so it has
  no record of its own.
- **The D-series records are back-filled.** They were written from the
  invariants as they exist in the code today, not from the original spec — this
  repository's history was squashed and the numbered spec is not in it. Their
  `date:` is `unrecorded`. The Context sections describe the failure mode the
  invariant defends against, which is verifiable from the code; they do not
  claim to reproduce the original discussion.
- **Numbers from 0015 up are contemporaneous** — written when the decision was
  taken, with a real date.

## Rules

1. **Never edit an accepted record.** A decision that turned out wrong gets a new
   record with `supersedes: DNN`, and the old one's status becomes `superseded`.
   The reasoning that led somewhere wrong is the most useful thing in a log.
2. **One rule per record.** If you cannot state it as something a person could
   violate, it is architecture prose — it belongs in `../architecture/`.
3. **Fill in Enforcement, even when the answer is "nothing".** That line tells
   the next reader how much the rule can be trusted, which is different from how
   much it should be.

Adding one: copy `template.md`, take the next free number. The index regenerates
on commit.
