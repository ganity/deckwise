# ADR 0283: Use a bounded main-process bridge for native SVG editing

- Status: Accepted
- Date: 2026-09-23
- Deciders: PI-Desktop maintainers
- Related: `04-ux/08-component-spec.md` §5.2.3; E2E-DECKWISE-PPT-SVG-SOURCE;
  E2E-DECKWISE-PPT-SVG-PREVIEW-RECOVERY

## Context

DeckWise previously presented the `ppt-master` SVG editor through the
`pi.browser` plugin view. This coupled a core courseware workflow to an
optional plugin and left the editor's interaction and visual treatment outside
DeckWise's control. Editing remains implemented by the local `ppt-master`
preview service, whose source must stay untouched.

## Decision

1. Render SVG slides and the editing interface in a native DeckWise work-panel
   component.
2. Keep the existing local preview service as the source of truth for SVG
   loading, staged edits, undo, annotations, and save-all.
3. Route service operations through main-process IPC. Validate the canonical
   project path under the workspace's `.deckwise-ppt/projects` directory,
   verify the lock file against `/api/health`, and allow only the editor's
   required routes and methods. Return referenced images as bounded data URLs
   instead of exposing the local service URL to renderer fetches.
4. Sanitize SVG markup before inserting it into the renderer and remove
   external resource references.

## Consequences

- The courseware editor is available without the Browser plugin and can follow
  DeckWise's work-panel layout and theme.
- The upstream `ppt-master` editor continues to own edit semantics; this avoids
  a fork but requires the bridge to track the service API used by the editor.
- The Electron main process becomes a narrowly scoped proxy for this local
  service; its route allowlist and resource bounds are security-sensitive.
