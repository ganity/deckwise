# 05. Onboarding

## 1. Decision for MVP

Use an **inline first-run checklist**, not a multi-page modal wizard.

Reasons:

- faster to first value
- less blocking
- easier to skip/return

## 2. First-run detection

Show checklist when any of these is true:

1. no provider configured
2. no secret present for default provider
3. no session exists yet

Persist dismissal state, but incomplete critical steps can reappear as banners.

## 3. Checklist steps

1. **Add a provider**
2. **Save an API key**
3. **Open a project folder**
4. **Send your first prompt**
5. *(Optional)* Load a development plugin

When the runtime catalog contains the enabled `deckwise-managed` provider with
at least one model, the renderer omits the provider and API-key steps. Managed
accounts use the existing sign-in flow; they do not need a supplier API key.
Project and first-prompt steps, their actions, and dismissal stay unchanged.
Without that catalog entry, existing BYOK guidance remains. Once all remaining
steps are complete, do not render an empty checklist. Catalog availability is
not a provider-health or billing-entitlement check.

## 4. Placement

- shown in main chat empty state
- provider and key items deep-link to Settings → Agent
- the optional plugin item opens the app shell's Plugins destination
- project and prompt items invoke their relevant app actions
- checklist collapses after core steps complete

## 5. Copy tone

English source, concise, action-oriented.

Example:

- “Add a model provider”
- “Save your API key”
- “Open a project to enable local tools”

## 6. Non-goals

- account signup
- cloud sync setup
- long product tour overlays
- forced tutorial for returning users

## 7. Acceptance

1. Fresh profile shows checklist
2. Completing provider+key+prompt removes critical empty-state blocker
3. User can dismiss optional parts without breaking app use
