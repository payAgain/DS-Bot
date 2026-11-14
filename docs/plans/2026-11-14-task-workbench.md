# Persistent task workbench and calendar

User-authorized first trial. One team entry opens the board and a right-hand task inspector. The same task records drive a month calendar, daily agenda with exact planned intervals, and an unscheduled list. Small screens retain horizontal board columns and put the inspector over the board.

## Data and behavior

- Task fields: title, description, personal/Bot kind, current Bot owner (or self), explicit status, waiting reason, planned start/end, all-day flag, IANA time zone, optional deadline, stable Bot/group conversation ID, and labelled HTTP(S) result links.
- Records live in `bot/tasks.json`, separate from the existing team state. No migration rewrites team settings. Absence means empty; no sample task is ever seeded by the plugin.
- A serialized read/validate/write queue, task revision checks, existing team single-host lock, and atomic replace protect updates. Rejected stale edits retain the user's draft. Invalid/unreadable files fail closed and remain on disk.
- All-day intervals use date-only values and exclusive end dates in the API; the form labels its end date as inclusive. Timed API values require explicit ISO offsets; stored instants normalize to UTC. The form converts wall times in the specified zone and refuses nonexistent/repeated DST wall times instead of guessing. An unchanged explicit timestamp retains its original instant. The viewing zone affects timed calendar placement only.
- Deadlines are date metadata and do not book calendar time. No drag scheduling in this trial: edit start/end to reschedule or clear both to unschedule.
- CRUD uses the existing authenticated `/api/bot` channel (`tasks-list`, `tasks-create`, `tasks-update`, `tasks-delete`). Mutations need `expectedRevision` except creation.
- `task_workbench` is an ordinary Bot-scoped tool using the same store. It supports list/create/update/delete and does not start a Bot or create any schedule. Tool reads/mutations hide other private Bots' task records; private Bots can only maintain tasks assigned to themselves. The browser is the user's full view.
- Status changes are explicit. No historical message classification, automatic task completion, automatic chat import, Apple Calendar writes, reminders, or workflow engine.
- Stable conversation IDs resolve through existing navigation so changing conversation parts does not break links. Result links only accept HTTP(S), reject embedded credentials and active schemes, and open with noopener. Local file result linking is deferred rather than granting filesystem access through a new task API.

## Compatibility and release

Implement on the installed 0.3.2-payagain.12 baseline and integrate the same feature into the latest custom source tree. Authorized host changes are only task storage/tool registration, task endpoints, task tool names, and protection of the task store in private-Bot filesystem checks. Do not update other host modules from 0.3.6. Rebuild generated clients from source. Rollback reinstalls the original package; `tasks.json` is retained and ignored by the older version.

## Upstream module coexistence

The 2026-11-15 source merge adds the upstream group-member task board. Its `src/host/tasks.js` module, `group_task` tool, and `room.tasks` state remain independent of this user workbench. The workbench host implementation is named `src/host/workbench-tasks.js`; its `task_workbench` tool, authenticated endpoints and separate `tasks.json` data format are unchanged. Both modules and styles are registered; neither board imports or fabricates the other's records.

## Verification

Persistent CRUD and restart, stale concurrent edits/deletes, malformed/read-only stores, owner and URL validation, empty production defaults, deadline separation, cross-day and midnight intervals, inclusive form vs exclusive API all-day end, named zones/DST, actual runtime tool registration/execution, board/calendar shared records, narrow and desktop browser rendering, unchanged configuration fingerprints and package allowlist.
