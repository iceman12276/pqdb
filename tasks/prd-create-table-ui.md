# PRD: Create Table UI

## Context

The dashboard's Table Editor page lists existing tables but has no way to create new ones. The empty state says "Create a table using the SDK or API." The backend `POST /v1/db/tables` endpoint already exists and accepts `{name, columns: [{name, data_type, sensitivity, owner}]}`. This is a single-story frontend feature.

## Introduction

Add a "New Table" dialog to the Table Editor page so developers can create tables directly from the dashboard without needing the SDK or API.

## Goals

1. Developers can create tables with columns from the dashboard UI
2. Supports all three sensitivity levels (plain, searchable, private)
3. Zero backend changes — uses existing POST /v1/db/tables endpoint

## User Stories

### US-101: Create Table dialog in Table Editor

**Description:** As a developer using the dashboard, I want to create tables from the Table Editor so I don't need the SDK or API.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] "New Table" button on the Table Editor page (top right, next to heading)
- [ ] Clicking opens a Dialog with form: table name input + column builder
- [ ] Column builder: add/remove columns, each with name (text input), data type (select: text, integer, bigint, boolean, uuid, timestamptz, jsonb, vector), sensitivity (select: plain, searchable, private), owner toggle
- [ ] At least one column required before submit
- [ ] Table name validated: lowercase, alphanumeric + underscores, starts with letter
- [ ] Submit calls `POST /v1/db/tables` with `{name, columns}` via new `createTable()` in table-data.ts
- [ ] Success: dialog closes, table list refreshes (invalidate query cache), toast/success feedback
- [ ] Error: shows error message in dialog (e.g., "Table already exists")
- [ ] Paused projects: button disabled when project is paused
- [ ] Unit tests for form validation logic
- [ ] Unit tests for createTable API function
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser: create table with mixed sensitivities, verify it appears in list

## Functional Requirements

- **FR-1:** New Table button visible on Table Editor page
- **FR-2:** Dialog form with table name + dynamic column list
- **FR-3:** Each column has name, data type, sensitivity, and owner toggle
- **FR-4:** Calls existing POST /v1/db/tables endpoint
- **FR-5:** Table list refreshes after creation

## Non-Goals

- Column editing/dropping (already on Schema page)
- Foreign key definition UI
- Advanced types (vector dimensions, custom enums)
- Table deletion from UI
- Backend changes

## Technical Considerations

### Backend Request Format (no changes needed)

```json
POST /v1/db/tables
{
  "name": "posts",
  "columns": [
    {"name": "title", "data_type": "text", "sensitivity": "plain", "owner": false},
    {"name": "email", "data_type": "text", "sensitivity": "searchable", "owner": false},
    {"name": "bio", "data_type": "text", "sensitivity": "private", "owner": false}
  ]
}
```

### Key Files

- **Modify:** `dashboard/src/components/table-list-page.tsx` — add New Table button + dialog
- **Modify:** `dashboard/src/lib/table-data.ts` — add `createTable()` function
- **Pattern:** `dashboard/src/components/branches-page.tsx` — Dialog + useMutation reference

## Success Metrics

- Developer can create a table with mixed sensitivities from the dashboard
- Table appears in the list immediately after creation
- Error states handled gracefully
