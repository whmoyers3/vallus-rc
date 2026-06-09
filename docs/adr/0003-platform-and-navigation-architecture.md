# 0003 — Platform and navigation architecture

**Status:** Accepted (2026-06-08)

## Context

VRC is used in two distinct contexts: office/desk work (load calculation, admin) and
field work (airflow balancing, quick edits on a plan). Field techs are iOS-only. Cell
signal is unreliable at job sites. A second tool (airflow balancing wizard) is planned,
with more tools possible beyond that.

These constraints created several interacting decisions that are hard to reverse
independently, so they are recorded together.

## Decision

**1. Single codebase, multi-tool app shell.**
All tools (load calculator, airflow wizard, admin panel, future tools) live in one React
app at one Vercel deployment. A persistent nav — icon rail on tablet/desktop, bottom tab
bar on mobile — provides top-level tool switching. Admin is hidden on mobile.

**2. Responsive layout, not separate mobile app.**
The load calculator is tablet/desktop-first (≥768px baseline) but degrades gracefully to
mobile for quick field edits (room changes, component edits, recalc). The airflow wizard
is designed mobile-first. A single responsive codebase handles both rather than
maintaining two separate UIs.

**3. PWA in Stage 1, Capacitor in Stage 2.**
Stage 1: web app with a PWA manifest and service worker. Techs can use "Add to Home
Screen" in iOS Safari. The airflow wizard route is cached for offline use on a
best-effort basis (iOS Safari may evict caches under storage pressure).
Stage 2: wrap in Capacitor when the airflow wizard is ready to ship and offline
reliability becomes a hard requirement. Assets bundle with the native app install,
eliminating iOS cache eviction risk. Distributed via TestFlight or MDM — no App Store
required. Zero UI changes at migration time.

**4. File exports via direct link, not fetch-then-blob.**
Export buttons (airflow spreadsheet, PDF report) hit backend endpoints directly as
`<a href="..." download>` link taps rather than programmatic fetch-then-blob. On iOS
Safari this triggers the native share sheet reliably; on desktop it triggers a normal
file download. The fetch-then-blob pattern is unreliable on iOS due to restrictions on
programmatic link clicks outside user gesture handlers.

## Alternatives considered

**PWA only (no Capacitor path).** Rejected because iOS service worker cache eviction is
not controllable by the app. A tech who caches the airflow wizard at the truck could find
it unavailable an hour later with no signal. Acceptable for brief dead zones; not
acceptable for extended no-signal job sites.

**Separate offline HTML download for airflow wizard.** Rejected because the airflow
wizard needs to collect readings (write state), not just display data. A static download
has no reliable local storage path on iOS Safari.

**Separate mobile app codebase.** Rejected — doubles maintenance burden with no benefit
given Capacitor wraps the existing React app unchanged.

## Consequences

- Do not use `alert()` / `confirm()` anywhere in the UI — use React modal components.
  WKWebView (Capacitor) does not support native browser dialogs.
- Do not use fetch-then-blob for file exports. Always use direct endpoint links.
- Service worker scope should cache only the airflow wizard route and its assets, not
  the full app. Load calculator and admin require network.
- The Capacitor migration is a build/packaging change only. No component or routing
  changes are expected at that time.
