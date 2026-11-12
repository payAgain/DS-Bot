# Custom integration with upstream dev (2026-11-12)

The integration starts from the deployed custom handoff fix and merges upstream dev ab2e9f0ac32eeb07e3b588b8e9122f371d00197f. It keeps the product persona modes, centralized approval inbox, exact-version shared skills, Composio account controls and strict WeChat acknowledgements.

- Upstream mobile API and the separately installed companion's admission API coexist. `mobile.js` owns the official API, while `mobile-admission.js` wraps only the three existing admission endpoints and delegates all others. A runtime regression checks both handshakes, one accepted submission across retries, changed-content conflict and stale-session refusal.
- Reload recovery first reconstructs the original handoff routing with buffered event sequencing, then adopts remaining live Agents and subagents. This preserves the deployed recovery fix and the upstream Stop behavior, without changing the host implementation.
- A late answer for an explicitly abandoned wait may be delivered once with the upstream late-answer label. Other duplicate terminal events remain suppressed. Administrative notice resolution, explicit no-reply notifications, ancestor checks and normal wait behavior remain covered by the tests.
- WeChat retains the previously tested protocol metadata and strict send ACK validation, including lossless uint64 IDs and schema-only diagnostics. Upstream session opening and expired-session handling are incorporated. All tests use local fixtures, not live WeChat sends.
- Upstream section controls and custom persona fields are both passed through Bot creation and update. New sign-in UI and the custom connected-app module remain available together.
- Custom interface copy is supplied in the five additional upstream languages; existing upstream translations take precedence. Generated client and phone-link bundles are rebuilt from source.

Validation includes the complete plugin suite and lint, shared-link and desktop checks, official mobile source checks, plus a real isolated DSH with a deterministic local mock. That smoke confirms both mobile handshakes, one-way notice completion, request/reply settlement and return to idle. It does not run the user's live team or guarantee natural model behavior.

This is a source integration. It does not install a production plugin, restart a gateway, build an IPA or invoke any live teammate Bot.
