# Inbox delivery alignment

The follow-up branch includes local main through `cbf9c0b380ed9c2b4854e60578e428ec620b2ce3`.

Azure PRs and failed/partially succeeded pipeline runs share the existing Inbox source, filters and detail layout. GitHub and Azure PRs both offer **Ask agent** and **Review PR**. Azure Ask uses the shared selected-context picker and revalidation; CI context contains run metadata and does not automatically download logs. Changes retains independent PR and CI provider choices.

The feed uses Azure's [project PR list](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests-by-project?view=azure-devops-rest-7.1) and [build list](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1). Existing project/assigned filters apply. PR scopes and completed CI lists are capped at 50 with a visible limit notice. Within that CI page, only the newest completed run per pipeline and branch can appear; a newer success suppresses an older failure. Boards and delivery failures are independent. PR list timestamps are creation/closure times, not comment activity tracking.

Opening an older Inbox run uses a verified [build ID lookup](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/get?view=azure-devops-rest-7.1) if absent from the recent review page (at most 50 recent plus one selected run). Existing account, repository, definition, revision and checkout checks remain in force for repair. Opening review does not modify checkout files.

Validation on macOS:

- Web tests and TypeScript passed; Rust formatting, Clippy and tests passed (271 passed, one ignored).
- Production web build passed, with the existing large-chunk advisory.
- Native app: live Azure PR appears beside Boards tasks; Ask loads its selected-context picker; Review opens its threads. GitHub Review PR opens the existing Code section. No agent message or provider write was submitted.
- Fresh review's older-CI-run finding was fixed and independently rechecked.

Live Azure CI, paid agent execution and Windows/WSL acceptance remain unverified. No release performance measurements were made; this change reuses Inbox caching and bounded provider reads, but that is not a measured latency claim. No persistence schema migration or new dependency was added.

## Follow-up UI, functional and performance review

Fixed the Azure context preview rendering raw JSON: description paragraphs and Markdown links now render normally, while revision evidence remains in the selected context. Blank provider comments are omitted. The embedded PR panel no longer repeats its external link or exposes Unlink (which could turn a pinned Inbox review into unrelated PR selection). Working-copy helper text now accurately describes review scope.

A fresh independent functional review found no remaining blocker after tracing the matching-checkout repair path. Native GitHub Code review and Azure context selection were exercised; no message was sent. The web suite passes 1,740 tests, including description preservation, blank-comment filtering, account mismatch, duplicate clicks, exact CI run selection and independent Boards failure.

Performance review is source-based: the assigned Azure feed adds three serial bounded requests (created PRs, review requests, completed builds), or two without the assigned filter. These run off the UI thread and reuse the 30-second Inbox cache. They can still add network latency; no release latency/CPU/memory benchmark was performed. Changes provider detection uses local Git on scope/visibility changes, not a new provider polling loop. PR threads and CI details remain demand-loaded.
