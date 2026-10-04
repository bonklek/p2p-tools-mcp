# Phone integration: P2P Tools Android 0.3.0-alpha.1

This repository contains integration source for ARM64 Android 11 or later. No prebuilt APK or transfer archive is published with this source update. The current build helper produces private debug artifacts that require a separate publication privacy review. GPT runs through your existing Hermes installation in Termux. A separate Seeker-derived APK owns Soulseek transfers and publishes verified music on the phone. The computer is only needed to deliver this initial package.

## Private build deliverables

- `p2p-android-0.3.0-alpha.1-arm64.apk`: signed standalone Android backend, distinct application ID `com.bonklek.p2p.android`.
- `p2p-android-0.3.0-alpha.1-termux.tar.gz`: built JavaScript, locked production dependencies, private installer and this guide. No account credentials or pairing tokens.
- `p2p-android-0.3.0-alpha.1-native-source.zip`: exact corresponding native source, upstream licenses and modifications.
- `SHA256SUMS` and `validation.json`: delivery hashes and build evidence.

The APK is signed with the local Android debug certificate for this private alpha. Keep its signing identity if upgrading this installation; a differently signed APK cannot replace it. Do not treat this as a public production release.

## Install on the phone

1. Copy the APK and Termux archive to Downloads. Verify the delivery hashes against `SHA256SUMS` before installation.
2. Open the APK from the phone's Files application. Grant installation permission to that application if Android asks. Existing Seeker installations are separate; their account and share settings are not copied automatically.
3. In Termux, install Node.js 20 or later if absent (`pkg install nodejs-lts`). Preserve the existing working Hermes installation. Current Hermes documentation flags its newer Termux APT package as broken; this installer does not upgrade Hermes.
4. If Termux cannot read Downloads, run `termux-setup-storage` and approve the local storage request. Extract the archive into Termux private storage:

```sh
mkdir -p "$HOME/p2p-android-delivery"
cd "$HOME/p2p-android-delivery"
tar -xzf "$HOME/storage/downloads/p2p-android-0.3.0-alpha.1-termux.tar.gz"
sh ./p2p-android-0.3.0-alpha.1/install-termux.sh
```

5. Open **P2P Automation**, then **Open music client**. Sign in to Soulseek in the app's account screen. Enter the account name and password there; never paste them into the agent conversation. Select a real music folder to share in the client's sharing settings and let its index finish.
6. Return to P2P Automation. Choose a music destination if needed; otherwise it uses internal `Music/P2P`. For a microSD card, use **Choose music destination folder** and grant persistent access to a music subfolder. A removed card causes jobs to wait; it does not silently switch to internal storage.
7. Tap **Enable automation and show pairing code**. Allow audio-library and notification permissions. The code expires after two minutes and five failed attempts. In an interactive Termux terminal run:

```sh
p2p-tools-android pair
p2p-tools-android status
p2p-tools-android register-hermes
```

The pairing prompt hides input. It saves a private token in `~/.p2p-tools/android.json` with permissions 600. Hermes registration preserves other settings and makes a private backup of an existing configuration. Restart Hermes or use its supported MCP reload command. Do not include this private configuration in a support bundle.

8. Start Shizuku using its phone-side setup and authorize Termux. Install the exported `rish` helper following Shizuku's instructions. Set `P2P_RISH` to its absolute path if it is not on the command path, then rerun registration. `p2p-tools-android shizuku` probes only `id`, with privileged environment preservation disabled. Downloads use ordinary Android permissions and do not require Shizuku. Reboot can require restarting Shizuku.

## Handoff to the phone agent

Ask the agent to call `p2p_setup_status` and `p2p_sharing_status`, then `p2p_library_find` for one artist/title before `p2p_music_fetch`. Preserve the returned job ID and reuse a `request_key` for retries of the same intent. Poll `p2p_music_status`; accepted native jobs do not depend on the MCP process remaining connected.

`needs_account_login`, `needs_library_permission` and `needs_storage_permission` mean the agent should give the user the exact local action, then retry status. It must not ask for passwords in chat. Pairing failures require a fresh local pairing code. Search returns opaque candidate IDs; the agent cannot supply arbitrary peer paths, filesystem destinations or privileged commands.

Jobs move through queued, downloading, verifying, enriching, publishing and published. Retry jobs search for another plausible provider when possible. Different versions and conflicting identity are held for review. Publication requires readable audio, expected duration, consistent title/artist, a unique MusicBrainz identity, and read-back SHA-256 verification. Ambiguous recordings can be held even when a file downloaded successfully. Existing tags/artwork are preserved; missing album fields require a uniquely supported release.

The destination's storage use is capped at 66%; private incoming storage retains a 1 GiB free floor. Queued bytes and publication copies count against the budget. These are storage safeguards, not speed limits. Downloads are not constrained to one active song. Files awaiting verification occupy private app storage; verified publication permits cleanup of only that job's private staging file. Established library files are never automatically deleted.

Changing destination during an accepted job holds it for review. Cancel does not delete established songs and cannot interrupt the final publication commit. A user's force-stop or Android foreground-service timeout stops the worker. Open P2P Automation and enable it again to resume durable jobs; the app does not promise unlimited background execution. Android 15 data-sync limits still apply.

## Required phone acceptance pass

Desktop tests do not establish that the phone can play a song. Before bulk use, the device integrator must:

1. Verify Hermes discovers all nine MCP tools and native setup reports ready.
2. Fetch one authorized test recording; observe a published receipt and play it in Musicolet.
3. Repeat the same request and verify no second publication.
4. Restart Hermes, interrupt a download, stop/re-enable the backend, and verify recovery without duplicating or losing the source.
5. Test screen-off, network loss, sharing, storage limits and a selected SD destination on the actual Android version.
6. Confirm actual share-index counts and peer connectivity. A share count does not prove incoming reachability.

Automatic Musicolet playlist repair and listening-history migration are not part of this first native package. Published music still needs player indexing and the above playback check.

## Rebuild

Use .NET SDK 10.0.401 with Android workload 36.1.2, Android SDK platform 36 and JDK 21. Run `android/build-backend.ps1 -JavaSdk <JDK directory>` from Windows; it prepares the pinned upstream revision and copies the tracked native additions. `android/prepare-backend.ps1` reconstructs only its managed build files. The source archive contains the prepared project and upstream licenses. MessagePack is updated to 2.5.303, the patched version identified by the upstream security advisory.

## Sources

- [Hermes Termux setup](https://hermes-agent.nousresearch.com/docs/getting-started/termux/)
- [Hermes MCP configuration](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/)
- [Shizuku setup](https://shizuku.rikka.app/guide/setup/) and [rish guidance](https://github.com/RikkaApps/Shizuku-API/blob/master/rish/README.md)
- [Seeker upstream source and license](https://github.com/jackBonadies/SeekerAndroid)
- [Android shared media](https://developer.android.com/training/data-storage/shared/media) and [document access](https://developer.android.com/training/data-storage/shared/documents-files)
- [Android 15 background limits](https://developer.android.com/about/versions/15/behavior-changes-15)
- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API)
- [MessagePack patched release advisory](https://github.com/MessagePack-CSharp/MessagePack-CSharp/security/advisories/GHSA-qhrr-8q5h-9q3h)
