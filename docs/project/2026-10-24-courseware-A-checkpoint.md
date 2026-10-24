# Courseware A pre-integration checkpoint

The courseware implementation and its tests, assets, specifications, and
validation reports are checkpointed before synchronizing the DeckWise fork
with compatible PI-Desktop changes. The committed baseline is `58a9c4f57`,
which equals `origin/main` fetched from `ganity/deckwise` on 2026-10-24.

All 1,183 modified or untracked paths present before checkpoint preparation
were additionally archived outside the repository in a private directory.
Generated worker backup directories remain local and are excluded from Git;
their files are retained in that archive. Existing ignored build outputs,
runtime state, and credentials are not source inputs to this commit.

This is a recovery checkpoint, not a new claim that every courseware path
has passed acceptance. The larger courseware roadmap remains paused.
The SQLite v24 compatibility patch and development watcher fix are included
as current work; upstream integration should reuse the canonical migration
implementations and retain their compatibility tests.
