# DS Bot mobile Web Push trial

Accepted base: production 0.3.2-payagain.18, preserving mobile hold/status, scheduled result receipts and the removed custom task workbench. Latest source integration is kept separately; this is not a whole-version upgrade. No native App/IPA, paid push service, new schedule or change to existing schedule rules is authorized by this trial.

## Verified platform and deployment

- Current same origin uses an existing loopback 3081 Tailscale identity proxy. It accepts only the configured exact login/authority and same-origin requests, strips Tailscale identity headers, forwards to the existing DSH web server, and exchanges the existing launch login into Secure HttpOnly cookies for a home navigation.
- The proxy currently drops home query parameters after reauthentication and rejects cross-site navigation with a query. Preserve only validated dsbot-pwa=1 and an optional bounded conversation id dsbot-push on exact home/index navigation. Preserve every identity/Host/Origin gate; do not alter TLS, Tailscale exposure or DSH internals. Back up and test the deployment-owned proxy before reloading only that proxy.
- Production has an existing /manifest.webmanifest for DeepSeek Harness (standalone, root scope, existing PNG icons), and no Service Worker registrations were found by read-only browser inspection. Preserve that manifest route unchanged. Only an explicit DS Bot PWA entry /?dsbot-pwa=1 opts its document into a separate DS Bot manifest/icon; normal DSH entry stays unchanged.
- DSH's public authenticated connection.fetch.register supports exact GET/POST routes. Serve versioned DS Bot worker/manifest/icons and device API there; worker response allows root scope. The worker has no fetch/cache handlers. Refuse to replace an existing root registration owned by another script; more-specific registrations are untouched. Cancel/unregister only this feature's subscription and registration.

## User flow

Settings → General → phone notifications trial. Ordinary iOS Safari explains Share → Add to Home Screen and offers the PWA preparation entry. iOS 16.4+ standalone plus actual Push/Notification/SW feature detection enables an explicit Subscribe button. Permission is requested only in the user gesture, not on page load. Show unsupported, non-standalone iOS, denied, subscribed, stale and server-accepted test states accurately. Provide owned-device unsubscribe and user-requested test notification. The phone must personally install and grant permission; local simulation or an accepted provider response is not proof of lock-screen receipt.

## Host and security

Persist one-time VAPID private keys and subscriptions in a private feature directory (0700/0600), never source, chat, logs or browser. The VAPID public key necessarily goes to PushManager. Existing DSH admission and Tailscale gates remain. Bind a device to a separate random Secure HttpOnly same-site cookie; store only its hash. Authenticate every API, require same-origin JSON plus a device-bound CSRF token for writes, return only that device's status, never other subscriptions/endpoints/keys. The current deployment has one allowed human Tailscale identity; do not invent a wider multi-user permission model. Private Bots are excluded by default and require an explicit owned-device choice.

Accept only validated HTTPS browser-service endpoints on trusted Apple/Google/Mozilla/Microsoft push hosts, no credentials/custom ports/fragments, valid bounded encryption keys, and public DNS destinations. Do not follow redirects. Do not log endpoint, p256dh/auth, cookie or raw provider errors. Reject cross-device endpoint takeover and cap devices, request sizes, queue and send concurrency.

Persist bounded event dedup/outbox before attempting a send. Resume never-started queued jobs; an interrupted in-flight/unknown send is not blindly repeated. Retry only explicit transient provider rejection with a small finite budget, not unknown acceptance or external business actions. Remove 404/410 subscriptions. Tests use generated fixture keys and an injected transport, never real devices.

## Accurate events

Use host lifecycle events, not model memory: final visible own-chat response, actual pending approval/question/view, and turn failure/block. No ordinary stream/progress notifications. A SILENT scheduled dispatch is not task success; if there is an actual returned report, a generic new-report notification is allowed. Existing hidden exchanges stay hidden. Notify only where a reliable visible conversation mapping exists; do not infer group completion from a member's hidden turn. Queue payloads are generic titles/bodies and minimal stable conversation ids, with dedup tags, no chat text or approval arguments.

The worker displays the self-contained generic payload without fetching the Mac (including while phone Tailscale is off). Clicking validates a fixed same-origin home URL, reuses/focuses or opens that origin and resolves the stable id against the authenticated roster. Opening private details still needs Tailscale. No guarantee of instantaneous delivery or permanent background execution.

## Validation and rollback

Test key/permission persistence, device ownership and CSRF, hostile endpoints/DNS, 404/410 cleanup, queue bounds and restart dedup, true event mapping, safe click targets, denied permission, existing SW/manifest coexistence, isolated authenticated resources/host, desktop/390px UI, and source/production package deltas. Production uses read-only verification until the user intentionally requests a test from their subscribed phone. Keep all existing account/pairing/permissions and schedules unchanged. Official plugin activation only. Rollback to accepted .18 retains server-private feature data and stops sending; document own-SW unsubscribe/retirement without deleting someone else's worker.

References: https://github.com/web-push-libs/web-push ; https://developer.mozilla.org/en-US/docs/Web/API/Push_API ; https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ . WebKit confirms iOS16.4+ Home Screen/user gesture, lock-screen notifications and no Apple Developer membership requirement.
