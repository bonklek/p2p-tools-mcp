# Privacy-safe publication

This working repository is not itself an unlinkable publication artifact. Its Git objects and local remote metadata preserve historical identities even when the tracked source tree is clean.

For a future public release:

1. Do not transfer, fork, mirror, or push any existing branch, tag, ref, or Git object.
2. Export only the approved source files. Exclude `.git`, `docs/plans/`, local configuration, caches, runtime data, build output, archives, and recovery material.
3. Build and scan the export in a new temporary directory. Inspect the exact npm file list before publication.
4. Create a brand-new repository and one new root commit using the future neutral author, committer, signing key, credentials, and repository namespace.
5. Create new tags and releases. Do not reuse old tag objects, commit identifiers, release text, PRs, issues, deploy keys, webhooks, or package credentials.
6. Run at least two independent source scans and one exact-artifact scan for credentials, emails, owner aliases, absolute user paths, old repository URLs, and Git identifiers.
7. Preserve the complete Viral Public License in the source export and every distribution. Do not replace it with an SPDX-listed license identifier.
8. Generate the public README and clone/install URLs only after the destination account and repository name are chosen; do not carry over any current-owner namespace.
9. Do not zip, tar, upload, or otherwise distribute the staging directory. Import file contents into the new Git root; Git will create fresh repository metadata. Normalize timestamps and ownership fields on every separately published package artifact.

The package remains marked `private` until a deliberate npm publication decision. Its `files` allowlist exists so dry-run artifact review is narrow and deterministic.

## Source export allowlist

- `.github/`
- `deploy/`
- `docs/cli.md`
- `docs/hermes-config.md`
- `docs/migration-from-standalone.md`
- `docs/user-guide.md`
- `docs/versioning.md`
- `examples/`
- `src/`
- `.gitattributes`
- `.gitignore`
- `LICENSE`
- `package-lock.json`
- `package.json`
- `PUBLICATION_PRIVACY.md`
- `README.md`
- `tsconfig.json`
- `vitest.config.ts`
