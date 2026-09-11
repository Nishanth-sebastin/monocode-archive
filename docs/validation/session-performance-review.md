# Session feature performance review — 2026-09-11

Scope: the current delivery UI and repair follow-up on `feat/16-agent-repairs`, covering PR discovery/review, pipeline review, linked summaries, Inbox navigation/provider choices, agent context selection and automatic repair checkout. This is a source/request-budget review with regression checks, not representative native release acceptance.

| Feature | Finding and current behavior |
| --- | --- |
| PR/CI tabs | React Activity preserves loaded DOM/scroll and suspends hidden effects. Generation checks discard late responses; hidden refresh events do not start new reads. No new polling. |
| PR discovery/review | Discovery remains on the delivery surface, with bounded pages. Opening refreshes PR identity and comments; files/iterations stay on demand. Full-thread digest is computed once per selected thread during preparation, even when multiple comments are selected. |
| CI source opening | Fixed all-source summary/job fanout. Initial run lookups use two concurrent lanes across visible CI panels. Only the first source automatically loads matching-run summary/jobs; remaining details are selected explicitly. Logs stay on demand. |
| CI request budget | At the 20-source cap, assuming every source has an exact matching run, initial reads fall from 62 to 24 Tauri invokes and from 140 to 45 Azure GETs (68% fewer Azure reads). Derivation: 20 × two GETs for definition/builds, plus two for first-run summary and three for its jobs. No exact run means 40 GETs / 22 invokes. These are traced request counts, not latency measurements. |
| Linked summaries and Inbox | Saved association summaries do not fetch CI jobs or logs. Provider preference reads are local and bounded to 100 saved choices; PR and CI settings remain independent. |
| Comment picker | At most 20 prepared comments; no provider reads merely mounting the picker. Per-entry metadata lookup is bounded at 20 × 20 local comparisons. Revalidation happens before dispatch; it was not removed to improve latency. |
| Checkout preparation | Shallow single-branch fetch; existing exact checkouts are reused. Native Git execution has a 120-second timeout and 1 MiB retained-output limit, is cancellable, and remains off the interactive thread. One preparation runs at a time. Account and PR revision are rechecked before publication; existing copies are never reset. Provider HTTP reads retain their existing timeout and may not abort immediately. |
| Agent handoff | Existing attachment/dispatch flow is reused; duplicate/stale/uncertain repair checks remain. Generic Send to agent attaches a draft for review. No live agent dispatch or streaming performance acceptance was performed. |

## Evidence and limits

- Full web suite: 1,614 tests, including first-source-only details, two-wide initial loading, queued reads skipped after hide, retained log/scroll and individual comment selection. Rust checks: formatting, Clippy, 270 passing tests and one ignored.
- Native macOS Azure test PR reads and automatic matching checkout preparation were observed. The comment picker was exercised without dispatching a repair.
- Hardware inventory: Apple M5 Pro, Mac17,9, 24 GiB RAM. No native release build benchmark, memory baseline, streaming load or Windows/WSL benchmark was obtained.
- A separate production React fixture built with 20 pipeline sources, 50 runs/source and 50 jobs/source. Browser automation returned a stale image/empty page tree, so no trustworthy frame or interaction timings could be collected. Build duration is not app performance evidence. The fixture and its server were removed.
- Live pipeline failure/retry/log scenarios, mixed-provider end-to-end acceptance, authenticated agent dispatch and platform performance remain unverified. Request-count reduction does not establish an equivalent percentage improvement in wall-clock latency.
