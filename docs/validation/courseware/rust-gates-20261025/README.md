# Rust delivery gates — 2026-10-25

Status: **PASS for the scoped source checks below**. The active Plan 007 goal
remains incomplete. No supplier call, login, database migration, service restart,
git commit/merge/push or deployment occurs in this increment.

The preceding repository check retained 33 rustfmt failures on files unchanged
from HEAD. Those files are now formatted with child traversal disabled. The
courseware RPC module's existing inline tests moved unchanged into
`crates/host-core/src/rpc/courseware_projects/tests.rs`, following its existing
sibling test-module layout, so formatted production code stays within the
1000-line limit. No new allowlist exception or production behavior is added.

`equivalence.json` verifies every touched production file against the exact
rustfmt output of its original HEAD contents. It also verifies the relocated
test body against the formatted original. This goes beyond ignoring whitespace:
string literals, macros, error handling and checks are not manually rewritten.

## Executed checks

| Check | Result | Evidence |
| --- | --- | --- |
| `cargo fmt --all -- --check` | Pass | `format-confirmed.txt` |
| `cargo test -p host-core --locked --jobs 2` | 1,211 passed; 2 ignored | `host-tests.txt`; `host-tests.json` |
| `cargo clippy -p host-core --all-targets --locked --jobs 2` | Pass with 11 existing warnings | `clippy.txt`; `clippy-warnings.json` |
| Architecture limits against known `origin/main` | Pass | `architecture-confirmed.txt` |
| `git diff --check` | Pass | `diff-confirmed.txt` |
| Exact rustfmt-only production equivalence | Pass | `equivalence.json` |
| Existing trial AppImage SHA-256 | Unchanged | `report.json` |

Clippy did not run with `-D warnings`; the source still has its prior style/
argument-count warnings. The two ignored Host tests are not accepted by this run.
No JS/UI tests or installer rebuild were repeated for the mechanical Rust-only
change. The earlier [package acceptance](../repository-gates-20261025/acceptance.json)
still describes its exact pre-format build and source inventory. It is not
rewritten to claim that the installer was built from today's formatted sources.
The package and separate pinned WiseOffice remain the existing trial deliverable.

## Remaining core conditions

The core paths are implemented and have scoped local/real-process evidence.
Acceptance still needs the chosen Platform/llm-ha/MAIC deployment and normal
teacher identity, one representative real scene lesson's visual/teaching/audio
quality, and an approved managed text budget/settlement policy. The last item
cannot be inferred from existing media prices or from post-call usage events.
Current Platform `PricingService` still excludes direct `LLM_CHAT`/`LLM_STREAM`
from its billable allowlist; `COURSEWARE` pricing counts business pages. This
increment does not introduce a token tariff or alter billing behavior.

The user was asked asynchronously for intended service URLs/config locations
and existing text budget policy. No answer is assumed from elapsed time. Unknown
paid tasks remain unchanged. No deferred team/coediting/virtual-classroom work
is resumed, and no whole-plan/release completion is claimed.
