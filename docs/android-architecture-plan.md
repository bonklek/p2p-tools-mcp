# Android architecture and delivery plan

Saved 3 October 2026. The intended product lets GPT, through Hermes in Termux, fetch music directly into the same phone's library. Shizuku supports selected Android operations. No desktop runtime or USB file transfer is required after installation.

## Architecture decision

Build a Termux-compatible Node MCP package paired with a Seeker-based Android application. Hermes calls the local stdio MCP; the MCP calls an authenticated loopback bridge in the Android application. The Android application owns accepted download jobs, verification, metadata enrichment, storage publication, and sharing. The agent interprets requests and reports results. GPT inference may still use the configured remote model API.

```text
User → GPT/Hermes in Termux → P2P MCP → paired Android bridge
                                         ↓
                        Soulseek → verify → enrich → publish
                                                      ↓
                                             Music player
Termux MCP → selected Shizuku operations when needed
```

The bridge is new work. Seeker's existing search share-intent helper does not establish a full search/results/download management API. Normal downloads must not depend on screen coordinates or an unlocked screen.

## Research findings and constraints

- Hermes supports local stdio MCP servers and per-server tool filters. Its environment filtering means setup must explicitly register required configuration locations. [Hermes MCP documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/).
- As researched on 3 October, Hermes's official Termux page flags its new packaged installation as temporarily broken. Preserve an existing working installation and verify MCP support before upgrading it. [Termux documentation](https://hermes-agent.nousresearch.com/docs/getting-started/termux/).
- Shizuku's rish shell may not access Termux-private executable directories. Run Node normally in Termux and delegate only selected system operations. [rish documentation](https://github.com/RikkaApps/Shizuku-API/blob/master/rish/README.md).
- Unrooted Shizuku startup without a computer uses Android 11+ wireless debugging and generally needs restarting after reboot. [Shizuku setup](https://shizuku.rikka.app/guide/setup/).
- Seeker is an Android C# client with Soulseek search, downloads, shares, and native filesystem services. Reuse its services rather than recreate the network protocol. [Seeker](https://github.com/jackBonadies/SeekerAndroid), [download service](https://github.com/jackBonadies/SeekerAndroid/blob/master/Common/Services/DownloadService.cs).
- Desktop slskd's ASP.NET Core stack is not established as a working Termux runtime. Limited .NET Bionic executable support is not proof that slskd works there. Keep this alternative outside the initial critical path. [slskd](https://github.com/slskd/slskd/blob/master/src/slskd/slskd.csproj), [Bionic support](https://github.com/dotnet/runtime/blob/main/src/coreclr/nativeaot/docs/android-bionic.md).

## First release support

ARM64, Android 11+, standard Termux, a verified Hermes MCP installation, and authorized Shizuku. Establish internal shared music storage first, then verify removable storage separately. Start with FLAC and MP3. The first supported request is one artist/title song, with optional album/version preferences.

## Backend boundaries

1. Acquisition: login status, search, candidates, enqueue with idempotency keys, transfer status, cancellation, retries, share status, and classified failures. Preserve the desktop slskd adapter and add the Android adapter.
2. Library: inventory, identity matching, tag/audio inspection, verified arrivals, duplicate candidates, and playable locations.
3. Storage: access/capacity probes, reservations, partial files, hashing, publication, cleanup, and unavailable volumes. Support paths and Android content/document URIs.
4. Platform: desktop ADB, native Android APIs, and narrowly scoped Shizuku operations behind separate adapters.

## Android bridge

Expose versioned capabilities, account status, search creation/results, job creation/status/cancellation, library query, storage status, and sharing status. Results are bounded and paginated. These are proposed endpoints, not upstream features.

Bind HTTP only to loopback and authenticate every operation. Pair through a short-lived code displayed in the app and entered in a hidden Termux prompt. Issue a random credential, store it privately, support revocation, and limit pairing attempts. Never put credentials in chat, shell arguments, MCP arguments, or logs. Accept opaque candidate/job/destination IDs rather than unrestricted paths or shell commands. Other apps can reach loopback; localhost is not an authentication boundary.

Keep the Android application package distinct from installed upstream Seeker to avoid replacing it or its account data. Pin upstream source and retain its license, notices, modifications, and corresponding build source with the artifact.

## Shizuku responsibilities

Provide capability inspection, selected system/package/media diagnostics, and later tested player actions. Validate arguments, bound output, set timeouts, and report missing authorization clearly. Do not run the network client or Node under Shizuku. Losing Shizuku pauses operations requiring it; already authorized native operations should continue where possible. Do not export a generic privileged shell as an MCP tool.

## Publication and storage

Replace PC staging and ADB pushes with phone-local incoming files, audio verification, enrichment, final publication, and durable receipts. Minimize full-file copies and account for temporary-copy overhead when required. Keep partials invisible to the music player. Library files must be user-visible and survive uninstalling Termux.

For app-owned MediaStore media, pending entries can hide work until publication. For SAF destinations, probe supported operations and verify the published stream; do not assume atomic rename. [MediaStore](https://developer.android.com/training/data-storage/shared/media).

Use a system folder picker and offered persistent URI permission for removable destinations. Check create/read/write/rename/delete/capacity and access after restart. Card removal or revoked permission pauses jobs with a reason. [Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files).

Maintain an occupied-percentage ceiling, minimum free bytes, reservations for remaining transfers, and staging headroom per actual volume. Preserve the user's 66% ceiling as configurable policy. Do not invent separate PC/phone budgets on one device.

## Metadata and album policy

Verify artist, title, duration, and recording identity. Preserve artwork and useful tags. Treat live/remix/alternate versions explicitly; album editions of a recording may be equivalent without implying identical release metadata. Prefer smaller files when identity and acceptable quality agree, and consistent album metadata when evidence supports it. Add release year and track position only when verified. Hold conflicts.

Retain MusicBrainz with caching, identification, request pacing, and recoverable failures. [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API).

Reuse the Python helper for initial validation where Termux file access is verified; production accepted jobs should run enrichment inside the native worker. Verify the selected Android tagging dependency. Shared fixtures must keep Android and desktop identity decisions consistent. Distinguish verified release, verified recording without release position, embedded-only review, and verification failure. Download completion is not library completion.

## Duplicates

Check the current library and active jobs before enqueue. Prefer recording IDs when present; otherwise compare artist/title, duration, and version labels. Reserve a recording against concurrent requests. Distinguish byte duplicates, audio equivalents, recording equivalents, alternate versions, and album editions. Add the earlier duplicate incident as regression fixtures. Cleanup defaults to package-owned temporary files; deleting established library files requires a separate keeper/references decision.

## Queue and sharing

Queue independent candidates, let healthy peers proceed, and classify remote queue waits, offline peers, connection failures, explicit rejections, interruptions, storage pauses, and verification failures. Reconsider providers appropriately and search further to meet verified-arrival targets. No artificial bandwidth cap or single-download constraint; resource protections must be explicit.

The phone must index actual user-selected shared music. Exclude partials and private data, report real share counts/upload readiness, and update the index after publication. Do not simulate shares. Diagnose login, incoming reachability, and peer connectivity separately. Test Wi-Fi, mobile data, network changes, and the user's chosen VPN. [Soulseek connectivity](https://github.com/slskd/slskd/blob/master/docs/config.md).

## Durable jobs and Android lifecycle

Persist requested → searched → selected → queued → downloading → verifying → enriching → publishing → playable, plus needs_user_input, retry_wait, paused_storage, held, and cancelled. Persist candidate IDs, idempotency keys, transfer IDs, byte reservations, and receipts. Reconcile uncertain submissions instead of repeating mutations blindly. Closing Hermes must not discard accepted native jobs.

Test screen-off operation, process death, and reboot. Wake locks/battery settings do not guarantee Termux persistence. Review native foreground-service restrictions, including applicable Android 15 data-sync limits. Evaluate Android 14+ user-initiated transfer jobs while observing their visibility/start requirements; a background agent request does not automatically qualify. [Foreground services](https://developer.android.com/about/versions/15/behavior-changes-15), [user-initiated transfers](https://developer.android.com/develop/background-work/background-tasks/uidt).

## Setup and credentials

Report missing requirements individually: Hermes model access, Soulseek login in the Android app, hidden local bridge pairing, destination/share pickers, Shizuku authorization, optional Jev configuration. Return a status, plain user message, local action, and verification step. Do not request a slskd key for the native Android backend. Never ask the user to paste account secrets in chat.

## Package and Hermes integration

Deliver built Node files, a signed Android backend APK, installer/pairing command, Hermes registration helper, compatibility manifest, checksums, notices/source, migration instructions, and troubleshooting. The phone installs artifacts rather than compiling the app. Detect runtimes/capabilities, install executable files in Termux-private storage, separate state/secrets from package files, merge one MCP entry without overwriting existing config, verify discovery, and preserve jobs across upgrades. Review distribution licensing before public publication. [Termux filesystem](https://github.com/termux/termux-packages/wiki/Termux-file-system-layout), [Seeker license](https://github.com/jackBonadies/SeekerAndroid/blob/master/LICENSE).

Expose a focused surface: setup status, library find, music fetch/queue/status/cancel, and sharing status. Fetch takes artist/title and optional album/version/preferences and returns a durable job ID promptly. Report already available, queued, downloading, held, and playable separately. Never hold an MCP request open for a whole transfer.

## Player integration

Prove published music appears and plays in Musicolet, then add refresh, album grouping checks, playlist export/import, and optional tested Shizuku actions. Distinguish downloaded, published, player-visible, and playlist-added. The separate local musicolet-mcp project currently analyzes backups; it is not assumed to control playlists.

## Implementation milestones and completion gates

1. Feasibility: verify Hermes MCP, Node, storage, Shizuku and backend capability.
2. Bridge: authenticate, search, enqueue and inspect one programmatic transfer.
3. Publication: verify/enrich/publish one correct file without desktop runtime.
4. Queue: exercise duplicates, idempotency, provider failures and reservations.
5. Lifecycle: retain jobs through process death, screen off, network changes and reboot recovery.
6. Packaging: build signed APK and Termux bundle, inspect contents/checksums and install procedure.
7. Device integration: install on a phone, prove one playable arrival, then validate larger batches and playlists.

The user's current build goal ends only when transfer-ready artifacts and their required build/package checks pass. Phone-dependent integration results must remain explicitly pending until exercised; do not claim live transfers from synthetic tests. Keep a delivery checklist and record artifact hashes, upstream commit, build commands, test results, known limits and device actions.

## Test matrix and measurements

Repeated/concurrent song requests, version/edition distinctions, rejected/offline/stalled peers, interrupted network, exhausted storage, removable-card loss, revoked permissions, agent/backend termination, interrupted publication, and upgrades with jobs. Measure unique playable arrivals/minute, duplicate arrivals, retry outcomes, reserved bytes, memory and recovery. Queue count is not completion evidence.

First full acceptance path: Hermes → local MCP → duplicate check → Android download → identity/metadata verification → durable publication → player playback, with screen off and computer disconnected.
