# Withdrawal of the custom personal task workbench

The user requested removal of the custom personal/Bot task workbench after trial. Remove its sidebar entry, board, calendar, custom schedule-in-workbench integration, model tool, authenticated endpoints, dedicated copy, and implementation tests. This supersedes the earlier trial design notes; do not restore the feature during ordinary upstream synchronization.

The upstream group-member board, group_task, group goals and the original schedule manager remain independent and unchanged. No schedule is copied, created, updated, paused, resumed or deleted by this withdrawal.

Keep any existing bot/tasks.json at its current path. Do not migrate, truncate or remove it, and do not restore an old whole team state over current chats or pairing. Recovery, if the user later requests it, uses the normal Git revert of this withdrawal plus the accepted trial package; old task records can be reused without a data reset.

Production can restore the accepted pre-workbench 0.3.2-payagain.12 package only after verifying that its differences from the active .15 package consist entirely of the custom workbench. The latest 0.3.6 source withdraws the feature through a normal child commit, preserving already published history and all upstream changes. Generated clients are rebuilt from source.

Verification covers absent custom tool/endpoints/client entry, preserved upstream group tools, readable original schedules, untouched retained task data, configuration fingerprints and read-only schedule configuration hashes. Concurrent external schedule changes must be recorded rather than reverted or misreported as unchanged.
