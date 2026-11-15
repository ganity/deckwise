# Consume authorized fixed multi-file selections

Status: accepted for the independent D module, 2026-10-20.

C2b now supplies authenticated fixed-file selection, metadata and signed URLs.
The existing loader accepts package bytes and an asset resolver; it does not
verify the separate manifest/source/report transport. Add one browser-safe
consumer beside that loader, accepting C's unknown projection, a trusted canonical
BuildRef, a Host-owned path download callback and the existing AbortSignal.

Validate the exact finite file set, immutable IDs, MIME/length budgets, raw
SHA-256 values, manifest membership and source/report/asset agreement. Then use
the existing full loader and return its LoadedFixedBuild/disposal contract.
Use installed zod and the unmodified canonical validator. Do not fetch URLs in
the runtime, invent an archive/public schema, add credentials or start another
player/clock. Existing local loads and C's legacy single-object API stay intact.

Host owns authenticated pointer selection, HTTP/envelope errors, bounded network
retrieval and signed-link renewal for the same immutable build. Byte validation
cannot attest that A persisted an authentic teaching/source/mapping snapshot.
Offline replay of C's response and original D build proves this consumer only;
actual Desktop team authorization and combined Host playback remain gates.
