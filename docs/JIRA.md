# Jira Cloud Inbox

Connect in **Settings → General → Jira Cloud**, then choose **Jira** in the existing Inbox. The default is **Assigned to me**. The existing filter popover offers friendly project and favorite-filter names, remembers the site-specific selection, and combines it with text, time and open/closed filters. Jira's actual status remains visible on cards and details.

Use **Inbox → Filter inbox → Visible sources** to choose which provider tabs to show. Multiple sources can remain visible, at least one stays selected, and the preference survives reopening. This controls tab visibility, not account connections or the shared refresh lifecycle. The Jira form uses visible field labels and a shared Jira mark (Simple Icons, CC0), with a full-width site field and aligned email/token fields.

Select a ticket to load its description/comments. **Send to agent** uses Linear's explicit local-project chooser and prepares a fresh conversation's existing composer card; the user reviews and sends it. **Ask** uses the existing Inbox conversation flow. **Open in Jira** opens the original ticket. Imported content is untrusted reference data. No Jira comments, transitions or assignments are written. Failed handoff retains the selected ticket/project; read errors offer local Retry. Jira never determines the Git, PR, CI or agent provider.

## Connection and limits

- This slice supports one `https://<site>.atlassian.net` Cloud account, using Atlassian email and an API token **without scopes** with the [documented direct-site Basic authentication route](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/). Scoped gateway tokens, OAuth and Server/Data Center are not implemented. Use a dedicated account with only the project-reading permissions needed; an unscoped token is not itself a read-only credential, even though this connector only calls GET endpoints.
- The token stays in the app host's `jira-config.json`, using GitLab's existing secret-file writer (0600 on Unix, application-data storage on Windows). It is not returned to the WebView, cached in browser storage, logged, or included in service errors. This is file-based storage, not a new encrypted vault. Disconnect deletes the local credential, not the remote token; revoke it in Atlassian when needed. No other installation's credentials are read or migrated.
- Calls run off the interactive thread, disable redirects, time out after 20 seconds and cap responses at 2 MiB. Search uses [enhanced JQL pagination](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/) with at most 100 issues/10 pages. Project/favorite choices are also capped at 100. Narrow the filter if needed; no normal-flow JQL entry is required.
- Details are on demand, bounded to 40 cached tickets/threads. The discussion view includes the newest 50 comments with an explicit truncation notice. ADF conversion supports common text, lists, links, code, quotes and readable tables, bounded to 64k output characters, 10k nodes and depth 32. Files are selected separately in the context dialog below.
- Jira joins the existing Inbox cache and refresh lifecycle, with generation guards against stale responses after disconnect/filter changes. There is no new polling process. Rate limits/service errors pause requests for 1–300 seconds (Retry-After, otherwise 30 seconds). Other providers retain their cards and local errors. GitHub/GitLab deduplication now includes provider identity so matching repository/issue numbers cannot hide a card.
- No existing schema changes or migration. Disconnect/reconnect recovers invalid credentials; saved filters contain only site and numeric project/filter IDs.

## Validation for #11

Local `npm run check` passed after the context changes: 1,531 web tests and 259 Rust tests (one ignored), including Jira pagination, custom states, site/project identity, favorite selection, ADF bounds, secret-free failures, disconnection races, selection persistence and rendered Inbox handoff/retry tests. Production `npm run build` was also repeated.

## Selected agent context

For GitHub, GitLab, Linear and Jira, **Ask** and **Send to agent** open the same compact review dialog. The detail pane has no permanent Context/Edit row. Description starts selected; comments and files are individual opt-ins. Expandable sections show author/date/excerpt, image preview and file sizes where known. Send uses the existing explicit local-project chooser inside this dialog. Confirmation opens a draft, never sends automatically.

The composer keeps its original ticket/source/label layout, with a separate context summary and readable **Preview selected context** section underneath. Selected files use existing removable attachment chips and host-aware dispatch. Text previews never load remote, inline or app-local images. Ask remains read-only; excluded context must not be fetched automatically. A changed selection cannot erase material already sent to an agent.

Checkbox IDs and page depth are saved for up to 100 account/ticket pairs and shared by Ask/Send, including after restart. New comments/files are not selected automatically. Bodies, file bytes, tokens and signed query strings are not stored in these preferences. This does not add durable Ask conversation storage. Failed reads/downloads/handoffs retain the selection and project; cancellation discards the pending handoff. A request already running on the host may finish after cancellation.

Preparation allows at most 20 files totaling 20 MiB and 100,000 selected text characters. Metadata loads at most five pages per comment type and 200 file links. GitHub includes conversation/review/inline comments; Jira uses attachment metadata; GitHub/GitLab/Linear discover uploaded Markdown links. Escaped Markdown URLs and arbitrary external download hosts are not supported. Open the provider for content beyond these bounds. No archive extraction, execution or OCR is performed; non-image files are delivered through the existing resource/file attachment path, not converted to model-specific document formats.

Downloads recheck current account and ticket membership, use provider-scoped authenticated routes, and reject unsafe hosts/redirects, excessive bytes and invalid image responses. GitHub attachment downloads require the app-host account to match the ticket-reading account, including WSL cases. GitLab requires its project-upload API; older self-hosted versions may not support it. Linear uses its private upload host. Each selected download currently revalidates its ticket independently, trading additional on-demand reads for simple ownership checks; there is no background attachment polling or new cache. Non-image temporary files reuse the existing attachment directory, with 0600 permissions on Unix; they follow the existing temporary-file lifecycle, without a new cleanup service.

Browser fixture checks covered the modal, mouse/keyboard expansion, selection shared across actions/reopening, cancellation, readable previews without image fetching, and equal source/label positioning with and without context. User preview feedback confirmed GitHub text retrieval and drove the modal/checkbox/chevron refinements. This is not authenticated image/file delivery acceptance for all providers.

Real React Inbox/Settings components were exercised in a browser with a mocked native bridge and fictional Jira data: all four sources, search/filter persistence, unread/mark-all, selection after switching/refresh, disconnected/empty/loading/error/retry, masked connection/disconnect, explicit local-project selection and failed handoff. Other-provider navigation remained interactive during a pending Jira refresh. Mouse and keyboard checks included source focus and moving to search. The minimum 240px list keeps all four source labels within their cells. These checks are not native-app or live-service acceptance.

Before/after Inbox images use the same 1280×800 dark viewport; the compact light image uses 800×600 with the minimum-width list. Settings reuses adjacent Linear/GitLab rows at 800×600. Screenshots contain fictional data.

![Inbox before](images/jira-inbox-before.png)
![Jira Inbox, dark](images/jira-inbox-dark.png)
![Jira Inbox, compact light](images/jira-inbox-compact-light.png)
![Jira Settings, compact dark](images/jira-settings-compact-dark.png)
![Visible Inbox sources](images/jira-visible-sources.png)

### Performance, compatibility and remaining acceptance

On Apple M5 Pro/macOS with Node 22.23.2, the production frontend main chunk changed from 2,891.71 kB (gzip 876.13 kB) at `840ed4c` to 2,922.46 kB (gzip 881.69 kB), including the shared context dialog. Existing large-chunk/dynamic-import build warnings remain. No dependency was added. This is bundle measurement, not app speed.

A development microbenchmark of minified affected JS (1,000 warmups, median of nine 1,000-call batches) measured filtering 100 GitHub items at 0.0134 ms before / 0.0122 ms after, and converting roughly 50k characters of Jira ADF at 0.0263 ms. These are Node-only measurements, not native/WebView/backend/network/agent costs; small differences are noise. Native release memory/CPU and responsiveness while a real agent streams remain unmeasured.

Upstream was checked through `8371181`; its newer image-preview change does not supply Jira browsing. Existing Inbox cards, filters, markdown, unread state, Settings rows, Ask and Linear handoff patterns were reused rather than replaced.

Still **unverified**: authorized Jira Cloud retrieval/auth/permissions and live handoff; native Windows credential behavior; Windows UI → WSL project/agent context; Jira + Azure Repos/Pipelines delivery; native streaming responsiveness. No authorized account or Windows/WSL test host was supplied. Full repository/base/branch/worktree/existing-session kickoff and persistent linked-session parity remain the shared #8/#32 integration, not a duplicate Jira implementation. This PR delivers #11's permitted read/handoff slice and does not close the entire issue's acceptance.
