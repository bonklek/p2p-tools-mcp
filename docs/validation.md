# Validation and remaining limits

This is the record of the September 2026 local audit and improvement cycle. Changes remain unreleased; no live services, VPN state, containers, downloads, Git history, or publication destinations were modified by the audit.

## What changed

| Area | Corrected behavior | Evidence |
| --- | --- | --- |
| Configuration | Reject malformed guard booleans, unknown operation IDs, conflicting aliases, invalid timeouts and unsafe endpoint shapes. Intentional boolean opt-outs remain supported. | Configuration regression matrix and disconnected-provider probes. |
| Torrent targets | Require explicit hexadecimal hashes; reject `all`, pipes, empty targets, conflicting fields and unknown arguments. Apply the same URL/magnet rules to legacy aliases. | Direct-handler and MCP SDK mutation tests. |
| qBittorrent | Preserve paused-add intent across 4.x/5.x; translate paused-list filters by version; reject add failure bodies; preserve empty category/tag filters; match hash case consistently. | Version-specific fixtures derived from tagged upstream implementations. |
| HTTP | Keep qBittorrent timeouts active through body reads, including login; reject service redirects. | Real Fetch tests against isolated loopback servers with stalled bodies and 307/308 redirects. |
| Jackett | Read hyphenated capability names; distinguish service errors and invalid document shapes from empty feeds; validate safe BTIH magnets. | Upstream-shaped caps, error, normal and malformed XML fixtures. |
| VPN | Distinguish accepted commands, observed state and unknown/transitional status; validate public-IP output. | Fake command/status transitions and IPv4/IPv6 response tests. |
| CLI | Invalid handler arguments use exit 2; command-specific help describes required stdin fields without loading configuration. | CLI-to-real-handler and help tests. |
| Tooling/deployment | Type-check tests; extend CI's configured runtime matrix; ignore default runtime data; restrict deployment export paths; document coordinated restart recovery. | Local type-check, Git ignore check, package-content inspection; container recovery still requires runtime evidence. |

## Verification standard

The pre-change baseline passed 57 tests, source type-check and build. New regression cases were run against that baseline before the revised implementation: 61 failed and 10 passed. These failures established that the added checks detect the targeted original behavior. Subsequent reviewer-discovered cases cover malformed XML and unknown VPN disconnect status.

The initial audit finished with 132 tests across 13 files, including protocol clients, handler boundaries, CLI behavior, an in-memory MCP SDK client/server connection for each server, and loopback HTTP failure tests. Source/test type-check and build passed. A separate controlled workflow through real CLI subprocesses and MCP stdio passed search, paused add, list/get, resume/pause, file-retaining delete, rejected add, invalid delete, and guard blocking before service invocation. `npm run check` checks both production and test TypeScript. Build and package checks run from a source snapshot in a scratch directory. Fixture results establish behavior of this implementation; they do not establish production incidence or live compatibility.

The subsequent bounded UX update adds `doctor` in the CLI and `p2p_doctor` in torrent-mcp, field-level validation guidance, and safe recovery steps. Independent Astra-low privacy and workflow reviews found no blocking regression; the workflow review identified missing format guidance through array/optional wrappers, which was corrected and covered by an actual CLI test. Additional tests cover independent probe failures, unverified isolation, deliberate guard opt-outs, unsupported status inspection, warning/blocked exit codes, configuration rejection before service access, and matching CLI/MCP reports. The suite now contains 147 tests across 15 files. These are local fixture checks, not live deployment evidence.

For the UX update, source/test type-check and the scratch build passed. The controlled CLI-subprocess/MCP-stdio workflow passed 14 checks, including equal doctor reports and requests limited to diagnostic endpoints. A package-content dry run with lifecycle scripts skipped (the build, tests, and type-check were run separately) included 60 files and the new doctor/diagnostic modules, without fixture or runtime data.

Run from a reviewed source checkout using the development runtime requirements in the README:

```sh
npm test
npm run check
npm run build
npm pack --dry-run
```

`build` replaces generated `dist/`; `pack --dry-run` invokes the package's build/test/check lifecycle. Preserve any unrelated generated work before using those commands.

## Optional basket implementation

The subsequent basket stage adds slskd, Prowlarr, Gluetun, cross-seed, Transmission, Syncthing, and IPFS/Kubo adapters. All default to disabled. Configuration is validated independently for each optional adapter; configured adapters have separate concurrency budgets, operation deadlines, and bounded HTTP responses. Shared search preserves provider failures and pending searches, including the existing Jackett handler. See the [basket guide](basket.md) for exact supported operations, API compatibility, configuration and remaining limits.

The suite passes 191 tests across 17 files. New cases cover malformed/disabled sections, independent failures, cancellation-resistant transports, stalled HTTP bodies, oversized responses, redirects, search partial results, guard blocking, RPC dialects and session challenges, slskd asynchronous/partial outcomes and reconciliation, scalar output validation, empty Kubo stores, and CLI/MCP discovery. Production/test type-check and scratch build pass. A real CLI-subprocess/MCP-stdio loopback workflow passed 12 checks, advertised 54 tools with all seven adapters configured, probed every adapter, and preserved another adapter after a provider failure. A package-content dry run with scripts skipped included 79 files, including 18 compiled integration files and the basket guide, with no fixture/test/runtime data. Build, tests and type-check were run separately.

Independent Astra-low protocol, privacy and workflow reviews identified and verified fixes for slskd transfer progress, identification of partial failures, batch acknowledgments, Transmission scalar validation, empty Kubo pin lists, required CLI field guidance, and reconciliation-ID documentation. Reviewers inspected source and fixtures; execution results above came from the coordinator's local runs. Live service compatibility, peer connectivity, downloads, VPN isolation and container behavior remain untested. Existing workspace build output was preserved; verification used a source snapshot.

## Compatibility changes to review before release

- Unknown keys, malformed values, duplicate alias spellings, ambiguous targets and unsupported torrent sources now fail explicitly. Former silent coercion/stripping is not preserved.
- Shared-handler errors may include `issues` and `next_action`; recognized CLI configuration errors now retain their specific configuration code. Doctor has an explicit report status in addition to the usual envelope; warnings exit 0 and failed checks exit 1. See the CLI guide before adapting scripts. Native MCP SDK schema errors may precede the shared handler.
- Hashes are individual 40- or 64-character hexadecimal values. Magnets require exactly one BTIH topic with a 40-character hexadecimal or 32-character base32 identifier. BTIH-only output omits trackers and display names.
- VPN lifecycle `connected` may now be `null`. Consumers must inspect `state_verified`; successful command acceptance alone does not prove a transition. A recognized opposite state is an operation failure.
- Service redirects are rejected. Configure the final HTTP(S) endpoint, including any reverse-proxy prefix.
- A paused list may make one cached service-version request. Each HTTP request has a body-inclusive timeout; a multi-request operation can take longer than a single request timeout.
- The package version remains 0.2.0 in this local draft. The maintainer must choose the appropriate release version for these interface changes before publication.

## Evidence limits and next step

No live Jackett or qBittorrent deployment, real MCP host, NordVPN installation, VPN leak protection, or container recovery was tested. The local run used Windows and Node.js 24.14.1. CI configuration includes other hosts/runtime versions; changing that configuration does not demonstrate that those jobs have run.

Search results intentionally omit sensitive download/tracker URLs. URL-only and private-indexer results may need acquisition outside this package. Redaction is heuristic: it can obscure benign titles and cannot identify every arbitrary embedded secret. Search `total` counts the returned page only. Response sizes and stdin are not given a hard application byte limit; unusually large inputs remain a resource risk. These are limitations, not completed fixes.

The highest-value next step is a separately authorized disposable integration run against the actual service versions and chosen VPN topology: search a permitted fixture, add paused, inspect, resume/pause, delete while retaining files, then test VPN restart and egress behavior. Do not infer that a green unit suite proves ongoing network isolation.

## Primary protocol references

- [qBittorrent 4.6.7 API implementation](https://github.com/qbittorrent/qBittorrent/blob/release-4.6.7/src/webui/api/torrentscontroller.cpp), [4.6.7 filters](https://github.com/qbittorrent/qBittorrent/blob/release-4.6.7/src/base/torrentfilter.cpp), and [5.0.0 API implementation](https://github.com/qbittorrent/qBittorrent/blob/release-5.0.0/src/webui/api/torrentscontroller.cpp). Tagged versions establish specific historical contracts, not every future release.
- [Jackett capabilities generator](https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Models/TorznabCapabilities.cs) and [results controller](https://github.com/Jackett/Jackett/blob/master/src/Jackett.Server/Controllers/ResultsController.cs). These moving references were inspected during the audit; changes warrant rechecking fixtures.
- [Fetch redirect semantics](https://fetch.spec.whatwg.org/#http-redirect-fetch), [Docker dependency lifecycle](https://docs.docker.com/compose/how-tos/startup-order/), and [Gluetun health/recovery](https://github.com/qdm12/gluetun-wiki/blob/main/faq/healthcheck.md).
