#!/usr/bin/env python3
"""
dead-code-audit.py — Find unused exports across the camstack monorepo.

Usage:
  python3 scripts/dead-code-audit.py                     # audit all packages
  python3 scripts/dead-code-audit.py packages/types      # audit specific package
  python3 scripts/dead-code-audit.py --summary           # summary only (no per-export detail)

Output:
  DEAD exports (0 external consumers)
  LOW-USE exports (1 external consumer)
  DEAD FILES (all exports dead)
"""

import subprocess
import re
import sys
import os
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
os.chdir(ROOT)

# Parse args
target_pkg = None
summary_only = False
for arg in sys.argv[1:]:
    if arg == '--summary':
        summary_only = True
    elif not arg.startswith('-'):
        target_pkg = arg

# Packages to audit
if target_pkg:
    audit_dirs = [f"{target_pkg}/src"]
else:
    audit_dirs = [
        "packages/types/src",
        "packages/kernel/src",
        "packages/core/src",
        "packages/sdk/src",
        "packages/ui-library/src",
    ]

# RG exclusion args
EXCLUDE = [
    '--glob', '!**/node_modules/**',
    '--glob', '!**/dist/**',
    '--glob', '!**/__tests__/**',
    '--glob', '!**/*.spec.*',
    '--glob', '!**/*.test.*',
    '--glob', '!**/generated/**',
]

def find_exports(src_dir: str) -> list[tuple[str, str]]:
    """Find all exported names in a source directory. Returns [(name, file_path)]."""
    result = subprocess.run(
        ['grep', '-rnE', r'^export (interface|type|class|const|function|enum) [A-Za-z]',
         '-r', src_dir, '--include=*.ts', '--include=*.tsx'],
        capture_output=True, text=True
    )
    exports = []
    for line in result.stdout.strip().split('\n'):
        if not line:
            continue
        match = re.match(r'(.+?):(\d+):export (?:interface|type|class|const|function|enum) ([A-Za-z0-9_]+)', line)
        if match:
            file_path, _, name = match.groups()
            if '__tests__' in file_path or 'generated' in file_path or '.spec.' in file_path:
                continue
            rel_path = file_path.replace(src_dir + '/', '')
            exports.append((name, rel_path))
    return exports


def count_consumers(name: str, exclude_dir: str) -> tuple[int, str]:
    """Count files outside exclude_dir that reference this name. Returns (count, first_file)."""
    result = subprocess.run(
        ['grep', '-rl', f'\\b{name}\\b',
         'packages/', 'server/',
         '--include=*.ts', '--include=*.tsx'],
        capture_output=True, text=True
    )
    files = [
        f for f in result.stdout.strip().split('\n')
        if f
        and 'node_modules' not in f
        and '/dist/' not in f
        and exclude_dir not in f
        and '__tests__' not in f
        and '.spec.' not in f
        and '.test.' not in f
        and 'generated' not in f
    ]
    return len(files), files[0] if files else ''


def main():
    total_dead = 0
    total_low = 0
    all_dead_files: list[str] = []

    for audit_dir in audit_dirs:
        if not Path(audit_dir).is_dir():
            print(f"⚠ Not found: {audit_dir}")
            continue

        pkg_name = audit_dir.replace('/src', '')
        print(f"\n{'━' * 55}")
        print(f"Auditing: {pkg_name}")
        print(f"{'━' * 55}")

        exports = find_exports(audit_dir)
        print(f"Found {len(exports)} exports")

        # Track per-file stats
        file_total: dict[str, int] = defaultdict(int)
        file_dead: dict[str, int] = defaultdict(int)
        dead_exports: list[tuple[str, str]] = []
        low_exports: list[tuple[str, str, str]] = []

        for name, src_file in exports:
            if len(name) < 3:
                continue

            count, first = count_consumers(name, audit_dir)
            file_total[src_file] += 1

            if count == 0:
                dead_exports.append((name, src_file))
                file_dead[src_file] += 1
                total_dead += 1
            elif count == 1:
                low_exports.append((name, src_file, os.path.basename(first)))
                total_low += 1

        # Print results
        if dead_exports and not summary_only:
            print(f"\n  DEAD ({len(dead_exports)}):")
            for name, src in dead_exports:
                print(f"    ✗ {name:40s} {src}")

        if low_exports and not summary_only:
            print(f"\n  LOW-USE ({len(low_exports)}):")
            for name, src, consumer in low_exports:
                print(f"    ~ {name:40s} {src} → {consumer}")

        # Dead files
        for f, total in file_total.items():
            if file_dead.get(f, 0) == total and total > 0:
                all_dead_files.append(f"{audit_dir}/{f} ({total} exports)")

        print(f"\n  Dead: {len(dead_exports)}, Low-use: {len(low_exports)}")

    # Summary
    print(f"\n{'━' * 55}")
    print("Summary")
    print(f"{'━' * 55}")
    print(f"  Dead exports (0 consumers): {total_dead}")
    print(f"  Low-use exports (1 consumer): {total_low}")

    if all_dead_files:
        print(f"\n  Potentially dead files (ALL exports unused):")
        for f in all_dead_files:
            print(f"    ✗ {f}")

    print(f"\nLegend: ✗ = dead (0 consumers), ~ = low-use (1 consumer)")

    # Exit code: 0 if no dead code, 1 if dead code found
    sys.exit(1 if total_dead > 0 else 0)


if __name__ == '__main__':
    main()
