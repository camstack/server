## What and why

<!-- What changed, and why this way. -->

## Checklist

- [ ] Tests cover the behaviour change (or this is docs-only)
- [ ] `npm run verify:push` is green
- [ ] If a `*.cap.ts` or a capability schema changed: `npm run codegen` was run and its output is in the diff
- [ ] If docs or generated references changed: `npm run docs:check` was run
- [ ] No private data: no secrets, tokens, house addresses, host names, or camera media (the repository guards refuse these)

For an addon or capability change, `scaffold_addon` / `scaffold_cap_stub` and
`validate_addon` (`camstack develop`, or the `@camstack/mcp-develop` server)
are the way to start. `validate_addon` should be green before the package is
published.
