#!/usr/bin/env python3
"""Verify the private DeckWise Python runtime."""

import importlib.util
import sys

REQUIRED = ["pptx", "xlsxwriter", "uharfbuzz", "pathops", "PIL", "yaml", "flask"]
FORBIDDEN = ["fitz", "pymupdf"]


def present(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def main() -> int:
    failures = [f"missing required module: {name}" for name in REQUIRED if not present(name)]
    failures += [f"forbidden module is importable: {name}" for name in FORBIDDEN if present(name)]
    print(f"python {sys.version.split()[0]} at {sys.executable}")
    for failure in failures:
        print(f"FAIL {failure}")
    if failures:
        return 1
    print(f"OK   {len(REQUIRED)} required modules present")
    print(f"OK   {len(FORBIDDEN)} AGPL modules absent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
