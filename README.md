# OTPilot Authenticator <img align="right" width="100" height="100" src="https://github.com/Hank076/Authenticator/blob/dev/images/icon.svg">

> OTPilot Authenticator generates 2-Step Verification (OTP) codes in your browser.

**Install:** [Chrome Web Store](https://chromewebstore.google.com/detail/otpilot-authenticator/compmlfocdmifebgiecbajaidkmgkonc) · [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/otpilot-authenticator/)

This is a fork of [Authenticator-Extension/Authenticator](https://github.com/Authenticator-Extension/Authenticator) ([source of this fork](https://github.com/Hank076/Authenticator)). On top of upstream, this fork adds:

- **Native Web Crypto encryption** — crypto-js is no longer maintained, so the vault moved to Web Crypto AES-GCM (Argon2id-derived key, a fresh random IV per record, GCM auth tag). A wrong password or tampered data now fails loudly instead of decrypting into a silently wrong code; legacy CBC ciphertext stays readable and upgrades on the next write.
- **Host-bound autofill** — codes are only injected when the page's real host matches the account. Upstream matched on the page title, which the visited site controls.
- **Smart filtering and search** — accounts related to the current site are highlighted by default. Search narrows the list by issuer or account name; you can turn smart filtering off in Preferences.
- **Master password required for cloud backup** — uploads are blocked entirely until one is set, so an unencrypted vault can never leave the device.
- **Dropbox backup via OAuth PKCE** — Authorization Code + PKCE through `chrome.identity.launchWebAuthFlow`; no client secret ships in the extension. (Google Drive backup was removed in 2026-07; OneDrive is a disabled placeholder.)
- **Smaller footprint in your tabs** — QR decoding moved from the content script into the background worker, cutting injected code from ~1.9 MiB to ~55 KiB. Four unused OAuth host permissions and their CSP `connect-src` entries were removed.
- **Modernized QR stack** — the parallel `qrcode-reader` / `jsqr` decoders were consolidated onto `@zxing/library`; `qrcode-generator` upgraded to v2.
- **Redesigned import flow** and a CSS custom-property design system (`sass/_tokens.scss`).

## Build Setup

```bash
# install dependencies (requires pnpm; version pinned in package.json "packageManager")
pnpm install

# build for a target
pnpm run [chrome, firefox, edge, prod]
```

Notes:

- Build output goes to `chrome/` / `firefox/` / `edge/` (bundles under `<target>/js/`); these directories are gitignored. Each target build wipes the other targets' output directories first.
- `pnpm install` downloads Chrome for Testing for the test suite: `pnpm-workspace.yaml` allows puppeteer's install script via `allowBuilds`. Set `PUPPETEER_SKIP_DOWNLOAD=true` to skip the download when you only build.
- `pnpm run prod` aborts if `src/models/credentials.ts` is empty (OAuth credentials are kept out of the repo). `chrome`/`test` builds only warn — everything works except live cloud backup.
- **Windows**: builds run through `bash scripts/build.sh`, so use a full [Git Bash](https://git-scm.com/download/win) (with complete coreutils). Running `pnpm run test` from plain PowerShell fails with `'bash' is not recognized`.

## Development (Chrome)

```bash
# watch build
pnpm run dev:chrome
# then load the unpacked extension from the `chrome/` directory
```

There is no auto-reload: reload the extension manually after each rebuild. The test suite runs automatically after every rebuild.

## Testing

```bash
pnpm run test
```

Runs the extension in a real browser via puppeteer with in-browser mocha (`headless: false`, so a GUI is required).

To run the same suite in Firefox, install puppeteer's Firefox once, then run the Firefox runner:

```bash
pnpm exec puppeteer browsers install firefox
```

```bash
pnpm run test:firefox
```

Set `FIREFOX_BIN` to use another Firefox binary.

## i18n

`_locales/en/messages.json` is the source of truth for keys. Crowdin is no longer used; other locales are maintained by hand. All locales must have the exact same key set as `en`, enforced by:

```bash
node scripts/check-i18n.js
```

## Acknowledgment

We would like to extend our heartfelt thanks to Laurent, the Chief Information Security Officer (CISO) of the University of Luxembourg, and the university's information security team for their invaluable security recommendations to the upstream project.
