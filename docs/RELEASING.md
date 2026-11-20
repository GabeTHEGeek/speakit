# Releasing SpeakIt

`.github/workflows/release.yml` builds SpeakIt on an Apple Silicon GitHub runner, signs it with a Developer ID certificate, notarizes and staples both the app and the DMG, and attaches the DMG to a GitHub Release.

## One-time setup: repository secrets

Add these under **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | What it is | How to get it |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | Your **Developer ID Application** certificate and private key, as base64 of a `.p12` file | In Keychain Access, find "Developer ID Application: …", expand it so the private key shows, select both, **Export 2 items…** as `.p12` with a password. Then run `base64 -i certificate.p12 \| pbcopy` and paste. |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` | |
| `APPLE_ID` | The Apple ID email of your developer account | |
| `APPLE_PASSWORD` | An **app-specific password** for that Apple ID (not your normal password) | appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer Team ID | developer.apple.com/account → Membership details |

The certificate must be a **Developer ID Application** certificate. An "Apple Development" or "Apple Distribution" certificate cannot be notarized for distribution outside the App Store. The signing identity hash in `tauri.conf.json` is left for local builds; CI overrides it with the identity found in the imported certificate.

## Cutting a release

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (and the lockfiles), and commit.
2. Tag the commit with the same version and push the tag:
   ```sh
   git tag v0.2.49
   git push origin v0.2.49
   ```
3. The workflow fails early if the tag does not equal `v` + the `tauri.conf.json` version.
4. When it finishes, the release `v0.2.49` exists with `SpeakIt_0.2.49_aarch64.dmg` attached and auto-generated notes. Pushing the same tag again replaces the DMG on the existing release.

## Testing the signing setup without releasing

Open **Actions → Release macOS DMG → Run workflow**. A manual run does the full build, signing and notarization, and uploads the DMG as a workflow artifact, but does not create a release.
