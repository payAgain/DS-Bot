# Touch reply shortcut and narrow conversation status

User-authorized Web mobile improvements. Keep the custom personal task workbench withdrawn and preserve the existing message menu and keyboard controls.

## Reply gesture

A primary touch held for 520 ms on a settled reply's empty bubble edge, paragraph gap or blank space after a line invokes the same quote action as the existing Reply button. It only fills the matching conversation composer; it does not send. Group replies keep the group's composer target and the same text used by the menu action.

A hold directly on text remains native selection/copy, including on iOS. Interactive descendants (links, buttons, code/copy controls, attachments, forms and cards) are excluded. No global user-select, touch-action or contextmenu restriction is introduced. Only the native callout associated with an eligible blank-space hold is suppressed. This narrower region is intentional: assigning selection and quote to the same text hold would make one unreliable.

Movement over 10 px, scrolling, another finger, pointer cancellation/lost capture, selection changes, visibility changes or blur cancel pending recognition. Synchronous layout-effect cleanup cancels on message/session changes and unmount. One completed touch suppresses its trailing click before mention navigation; fresh taps and keyboard actions remain independent. Streaming replies and read-only preview bubbles without a composer expose no gesture.

## Status

The current mobile conversation title gains a stable second line at widths through 700 px, with a full accessible description and text rather than only color. The desktop pill remains unchanged. The narrow title height and transcript padding reserve the line so tool/status changes do not move controls or jump the transcript; group-goal pods retain separate space.

A shared selector drives the header and team drawer. Priority follows valid pending approval, pending answer, real own work, work in groups, actual handoff waits, explicit persistent blocking metadata, idle. Old activity alone and message previews never imply work. Bot views resolve the owner's current conversation part, including when an earlier part is open. Groups use only their own live members and approvals, show a genuine member count when several work, and never borrow another group's activity or an unrelated Bot error. Only explicit bot.blocked metadata produces the attention state; a failed historical reply does not.

Subscriptions use the existing live work/session/roster sources, including normal foreground refresh. Text is derived on each snapshot, not stored per previous selection. No host APIs, stored preferences, task records or schedules change.

## Verification and device boundary

Cover tap/hold/move/cancel/selection/interactive targets, trailing click, repeated holds, group target, streaming/unmount, every status priority, stale data, part and conversation switches, group scope, and 390 px rendering. Actual DOM gesture checks run in an isolated DSH with mock replies and verify one composer quote without a new message. Synthetic pointer events and Chromium viewport emulation are not physical iOS testing.

This patch updates the Web plugin. The separately installed native mobile app uses its own Pressable/native text-selection code and is not changed, built or installed by this Web release. Native delivery must be identified separately rather than described as already updated.
