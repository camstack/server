# Broken-addon fixture

Used by `e2e/suites/addon-failure.spec.ts`. Throws at module load to
verify the AddonLoader surfaces the failure rather than silently
skipping.

DO NOT publish this directory. The package name (`@camstack/addon-broken-fixture`)
is reserved for fixture use only.
