# Android delivery checklist

Goal: built artifacts ready to transfer to a phone for Hermes, Termux and Shizuku integration. The architecture is retained in [the plan](android-architecture-plan.md).

## Build and package requirements

- [x] Preserve architecture plan and research sources in repository documentation.
- [x] Pin Android backend upstream source and use a distinct application ID.
- [x] Build authenticated Android bridge and native download/publication worker.
- [x] Build phone-local MCP and setup/pairing/Hermes registration commands.
- [x] Verify duplicate/version identity, budget, durable phase and credential boundary checks; device-only behavior remains below.
- [x] Build ARM64 signed APK and inspect package metadata/signature.
- [x] Assemble Termux bundle with built JS, dependencies, installer and integration guide.
- [x] Assemble corresponding native source, notices and reproducible build instructions.
- [ ] Rebuild and audit distributable artifacts before public release. Private build evidence is not included in the source publication.

## Public artifact requirements

- [ ] Build a release APK without debug symbols or private source paths.
- [ ] Use a release signing identity and verify the manifest is not debuggable.
- [ ] Scan every expanded artifact and normalize archive timestamps and owners.
- [ ] Preserve all corresponding-source and license obligations.

## Device integration requirements

Pending until exercised on the device. These are not desktop build claims.

- [ ] Verify installed Hermes version and MCP support; preserve a working installation.
- [ ] Install backend APK, enter Soulseek account login in its local UI, select shares.
- [ ] Install Termux bundle and pair in hidden local prompt.
- [ ] Register/reload Hermes MCP and verify setup status.
- [ ] Start/authorize Shizuku and probe selected shell access.
- [ ] Fetch one song, inspect verification/publication receipt, play it in Musicolet.
- [ ] Repeat request and confirm no duplicate arrival.
- [ ] Exercise screen-off, app/agent restart and network recovery.
- [ ] Exercise selected storage cap and removable storage when available.
