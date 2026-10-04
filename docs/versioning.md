# Versioning and release policy

p2p-tools-mcp uses SemVer-style versioning for package releases: `MAJOR.MINOR.PATCH`.

Current package version is declared in `package.json`. The `p2p-tools` CLI and both MCP server constructors report the same API version (`0.2.0`) from one shared source constant.

## Version increments

- PATCH: bug fixes, documentation-only updates, CI-only updates, and implementation changes that do not alter the documented MCP tool interface or configuration shape.
- MINOR: backwards-compatible additions such as new optional config keys, new tools, new optional tool arguments, or expanded structured response fields.
- MAJOR: breaking changes such as renamed/removed tools, required config changes, changed argument meanings, or incompatible structured response changes.

## API compatibility scope

Compatibility is evaluated for:

- package binaries: `p2p-tools`, `vpn-mcp`, and `torrent-mcp`
- package scripts documented in `package.json`: `npm test`, `npm run build`
- package lifecycle: `prepack` must rebuild, test, and type-check the exact source before creating an artifact
- environment variable: `P2P_TOOLS_CONFIG`
- YAML configuration keys documented in `examples/config.yaml`
- MCP tool names, required arguments, and structured response/error shapes
- CLI command names, flags, JSON envelopes, and exit-code meanings

VPN lifecycle is separate from torrent lifecycle. `torrent-mcp` can enforce only the operational network guard predicate; it does not auto-connect VPN. Changes to these boundaries are compatibility-impacting and should be treated as at least MINOR, or MAJOR if they break documented behavior.

Windows, macOS, and Linux are equal deployment targets. Changes that alter local service endpoint defaults or introduce operating-system assumptions should be called out in release notes.

## Release checklist

Before tagging a release:

1. Update `package.json` version.
2. Update the shared package/interface version in source to match every package-version change; the equality is tested.
3. Ensure README, `examples/config.yaml`, the CLI Guide, User Guide, Hermes wiring, migration guide, and this file match package scripts, binaries, schemas, and defaults.
4. Run `npm test`.
5. Run `npm run check` and `npm run build`.
6. Run `npm pack --dry-run` and review every included path.
7. Confirm the exact upstream VPL text is present in source and the package.
8. Scan the exact source export and tarball for credentials, personal paths, repository-owner identity, and generated debris.
9. Review the public changes and create the release commit in the destination repository.
10. Tag the release from that commit.

The package remains `private: true` until an intentional npm publication decision. Removing that guard is a separate release action, not a routine build step.

For a first public release, also follow `PUBLICATION_PRIVACY.md`: import only allowlisted file contents into a fresh repository and root commit. Do not transfer or reuse historical Git objects, refs, tags, or release metadata.
