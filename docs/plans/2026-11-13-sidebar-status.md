# Sidebar current work status

The user wants each Bot's secondary sidebar line to show only its current work status. Bot rows no longer read message previews, including the Main Bot tile's tooltip. Idle is always localized through the existing Idle key. The Main Bot tile uses the same status line instead of its role chip; the stored role is unchanged.

Pending tool approvals take priority, followed by pending question/interactive-view answers, own-chat live work (using the detailed work record), work in a group (group name and doing), real outstanding handoffs, then Idle. Settled cards and stale activity categories cannot invent pending or active work. Busy lines keep the existing shimmer; idle and waiting lines remain static. Group conversation previews and Agent rows retain their existing behavior.

For production this UI-only patch is built on the installed 0.3.2-payagain.11 source. The .12 package changes only package version and the generated client. Host modules, global authorization, WeChat, handoff routing and companion APIs remain byte-identical. The equivalent patch is also maintained on latest 0.3.6 custom source without deploying that cross-version update.

Tests render actual sidebar rows for idle, specific work, group work, handoffs, approvals, questions/views, settled cards, stale activity, Main Bot and Chinese localization. Real GUI verification uses the existing URL after official plugin activation and refresh; no synthetic state is inserted into production.
