# DeckWise changes

## 0.17.6 — 2026-10-12

- Preview TXT documents and plain-text attachments directly in the local
  text viewer, preserving their content without WiseOffice conversion.

- Open supported Office formats in the built-in editor. Workspace
  documents keep revision history; legacy formats save OOXML copies, while
  PDFs and attachments open read-only.

- Confirm PPTX editor readiness before opening the document, show loading
  feedback, and recover failed startup with a fresh session through Retry.

- Preview PDF attachments inside DeckWise up to 256 MiB, with a system-default
  application action for oversized PDFs and other binary attachments.

- Configure the built-in AI context window in Settings → Models, using presets
  or a custom token count. The setting persists locally and applies to future
  requests without changing custom providers or platform credentials.
