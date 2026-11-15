# ADR 0288: Load the Office Module in the Isolated Editor View

- **Status**: Accepted
- **Date**: 2026-11-02

## Context

The Office editor already runs in its own sandboxed Electron `WebContentsView`
with a dedicated session and a narrow preload. Its bundled route added a host
HTML page around WiseOffice's full application shell, while DeckWise needs only
the document editing module and its existing controlled file and teaching
protocols.

## Decision

Load WiseOffice's `module.html` directly in that isolated view when the staged
bundle contains it. Keep the legacy host route as a compatibility fallback for
older staged bundles and remote editor URLs. The module reuses the existing
buffer-open, validated-save, page-lineage and teaching commands. The preload
remains limited to command subscription and event delivery, runs only in the
top-level frame, and never exposes filesystem or general IPC access.

The host sends only the editor theme and teaching-sidebar visibility as UI
configuration. The workbench continues to own file identity, save status,
focus layout and the optional inspection panel.

## Consequences

- The bundled editor no longer boots the WiseOffice full application shell or
  the intermediate host page.
- The Office SDK's own internal editor frame remains in use inside the isolated
  view.
- Existing file validation, atomic replacement, revision checks, teaching
  bindings and save acknowledgements remain authoritative.
- Bundles without `module.html` continue to use the previous host route.
- Renderer and Office code remain origin-isolated; host communication is still
  subject to the editor-view sender and frame checks.

## Alternatives

- **Mount the editor in DeckWise's main React renderer**: rejected because the
  same-origin Office SDK code would share the main renderer's page privileges.
- **Keep booting the full WiseOffice page inside the host wrapper**: preserves
  the extra shell and loads unrelated startup code without improving isolation.
