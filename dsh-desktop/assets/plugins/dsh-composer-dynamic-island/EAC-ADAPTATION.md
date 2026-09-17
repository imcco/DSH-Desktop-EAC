# EAC adaptation note

- Upstream: <https://github.com/says693/dsh-composer-dynamic-island>
- Upstream commit: `2ccd12ff807c3bc983defd2177e15be1a416106f`
- Upstream version: `2.1.0`
- Vendored for: DSH-Desktop-EAC `web-desktop` profile

The runtime files under `lib/`, the Community v0.15 manifest, Cordis patch,
license, compatibility document, and bilingual READMEs are copied from the
upstream commit without behavioral changes.

EAC adds only client-loader dependency metadata in `package.json` so the Web
settings and slot modules are loaded before this adapter. Registration,
default selection, profile copying, and tests live in the EAC repository.

Automatic upstream replacement is intentionally not enabled: an upstream
update must first be reviewed and the EAC loader metadata revalidated.
