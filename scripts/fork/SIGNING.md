# Code signing for the fork (macOS + Windows)

The fork ships desktop builds to the team through GitHub Releases on `sethhen/t3code` with
auto-update. Auto-update needs signed builds: on macOS electron-updater (Squirrel.Mac) only
installs an update whose signature satisfies the running app's designated requirement, and on
Windows a signed build pins the publisher name that every later update must match.

The fork keeps bundle id `com.t3tools.t3code`, which is registered to T3's Apple team, so it can't
have a provisioning profile or the Associated Domains (passkey) entitlement. It uses plain
**Developer ID signing + notarization**, and Windows uses **Azure Artifact Signing** (formerly
Azure Trusted Signing), the only Windows signer the upstream pipeline supports.

|                                              | Seth's hands-on time | Lead time                                          | Cost                                       |
| -------------------------------------------- | -------------------- | -------------------------------------------------- | ------------------------------------------ |
| Apple Developer Program (organisation)       | ~1 h                 | 1–3 weeks (D-U-N-S + Apple's verification call)    | US$99/yr (A$149 in Australia)              |
| Developer ID cert + API key + secrets script | ~30 min              | same day                                           | included                                   |
| Azure Artifact Signing (organisation)        | ~1–2 h               | a few days, longer if Microsoft asks for documents | US$9.99/month Basic (billed in AUD, ~A$15) |
| Pipeline changes (Claude)                    | none                 | ~1 session once the secrets exist                  | Actions minutes are free on a public repo  |

## Checklist

**Seth does** (the secrets must never pass through chat):

1. [ ] Enrol Wingman AI Pty Ltd in the Apple Developer Program (section 1.1).
2. [ ] Create the Developer ID Application certificate and export it as a `.p12` (1.2, 1.3).
3. [ ] Create an App Store Connect **Team** API key with the Developer role and download the `.p8` (1.4).
4. [ ] Run `scripts/fork/set-signing-secrets.sh` (1.5).
5. [ ] Set up Azure Artifact Signing and pass organisation identity validation (2.2).
6. [ ] Run `scripts/fork/set-signing-secrets.sh --windows` (2.2 step 9).
7. [ ] Store the `.p12`, its password and the `.p8` in 1Password, then delete the copies in Downloads.
       The `.p12` is the only copy of the certificate's private key. Apple keeps no copy of the `.p8`.
8. [ ] Add calendar reminders for the expiry dates listed in section 4.

**Already built** (`.github/workflows/fork-release.yml`, runs on every push to `main`):

- macOS arm64 is built without T3's `--signed` mode, so the passkey entitlement and provisioning
  profile never enter the build. electron-builder still signs it with the Developer ID certificate
  (`CSC_NAME` + a throwaway keychain), notarizes and staples it (a `notarytool` keychain profile), and
  applies its default hardened-runtime entitlements. A verify step blocks publishing unless the app is
  Developer ID signed, notarized, free of Associated Domains, and its feed points at `sethhen/t3code`.
- Windows x64 is signed with Azure when all seven Azure secrets exist; otherwise it ships unsigned
  with a warning.
- Until the five Apple secrets exist, every run is a dry run: unsigned builds as workflow artifacts,
  no release.

**Claude does** once the secrets exist: re-run "Fork release", check the first signed release
(section 3 and `publisherName` in `app-update.yml`), and walk teammates through the one manual
DMG install. After that, updates arrive in the app.

## 1. macOS: Developer ID + notarization

### 1.1 Enrol in the Apple Developer Program

<https://developer.apple.com/programs/enroll/>. Sign in with the Apple Account that becomes the
**Account Holder**. Use a company address, because only the Account Holder can create Developer ID
certificates.

- **Organisation (recommended).** Enrol as _Wingman AI Pty Ltd_. The certificate reads
  `Developer ID Application: Wingman AI Pty Ltd (TEAMID)`, the same legal name that appears as the
  Windows publisher. It needs a D-U-N-S number for the company. Apple's lookup tool
  (<https://developer.apple.com/enroll/duns-lookup/>) requests one for free if the company has
  none. Issuing takes up to ~5 business days, then Apple can take a few more days to see it.
  Apple verifies the company, usually with a phone call. It also needs a public website on the
  company domain and a work email on that domain. You must have authority to bind the company
  legally, which a director of a Pty Ltd has.
- **Individual.** This is faster (a day or two, ID check in the Apple Developer app), but your
  personal legal name becomes the developer name, for example
  `Developer ID Application: Seth Henry (TEAMID)`. Converting to an organisation later goes through
  Apple Support and is slow.

Note the 10-character **Team ID** (Membership details). It's public and appears in `codesign -dv`
output.

### 1.2 Create the "Developer ID Application" certificate

Sign in as the Account Holder. Use either method:

- **Xcode:** Xcode → Settings → Accounts → select the Wingman team → _Manage Certificates…_ →
  `+` → **Developer ID Application**. The private key is created in the login keychain.
- **Web:** Keychain Access → Certificate Assistant → _Request a Certificate From a Certificate
  Authority…_. Enter your email and the common name "Wingman AI Pty Ltd", leave CA email empty,
  and choose _Saved to disk_. Then go to
  <https://developer.apple.com/account/resources/certificates/add> → **Developer ID Application**
  → _G2 Sub-CA (Xcode 11.4.1 or later)_ → upload the `.certSigningRequest` → download the `.cer`
  and double-click it to install it next to its key.

Check it with `security find-identity -v -p codesigning`. It should list
`"Developer ID Application: Wingman AI Pty Ltd (TEAMID)"`.

Choose **Developer ID Application**, not "Developer ID Installer", "Apple Development" or
"Mac App Distribution". The certificate is valid for 5 years.

### 1.3 Export it as a `.p12`

Keychain Access → _login_ keychain → **My Certificates** → find
`Developer ID Application: Wingman AI Pty Ltd (…)` and expand it to confirm a private key is
nested under it. Then right-click the certificate → _Export…_ → _Personal Information Exchange
(.p12)_ → set a strong password.

Export only this one identity. The script rejects a `.p12` with zero or several Developer ID
identities, one without the private key, or one that won't open with the password.

### 1.4 Create the App Store Connect API key (for notarization)

<https://appstoreconnect.apple.com/access/integrations/api> (Users and Access → **Integrations** →
App Store Connect API → **Team Keys**). If this is the first key, click _Request Access_ and accept
the terms. You need the Account Holder or an Admin to do this.

1. _Generate API Key_ (`+`). Name it `t3code-notarize` and set Access to **Developer**. Developer
   is the lowest role that can notarize, and it can't manage users or apps.
2. Note the **Key ID** (10 characters, e.g. `2X9R4HXF34`) and the **Issuer ID** (a UUID shown above
   the keys table).
3. Click _Download API Key_ to get `AuthKey_<KEYID>.p8`. **The download works only once.** If you
   lose the file, revoke the key and create a new one.

It must be a **Team** key. Apple's docs say individual keys "aren't able to use … `notaryTool`"
(<https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api>).

### 1.5 Store the secrets

```bash
cd ~/Documents/Work/t3code
scripts/fork/set-signing-secrets.sh --dry-run   # optional: validate only, set nothing
scripts/fork/set-signing-secrets.sh
```

The script prompts for the `.p12` path and password (hidden), the `.p8` path, the Key ID and the
Issuer ID. You can drag files into the terminal. It validates everything, including a
`notarytool history` call with the key when Xcode is installed. It then pipes each value into
`gh secret set` and prints only the secret names.

To add the secrets by hand instead, go to GitHub → `sethhen/t3code` → Settings → Secrets and
variables → Actions → _New repository secret_:

| Secret             | Value                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`         | base64 of the `.p12`, one line: `base64 < cert.p12 \| tr -d '\n' \| pbcopy`                                                           |
| `CSC_KEY_PASSWORD` | the `.p12` export password                                                                                                            |
| `APPLE_API_KEY`    | the **raw text** of the `.p8`, including the `-----BEGIN PRIVATE KEY-----` lines. The workflow writes it to `AuthKey_<id>.p8` itself. |
| `APPLE_API_KEY_ID` | the Key ID                                                                                                                            |
| `APPLE_API_ISSUER` | the Issuer ID                                                                                                                         |

Don't set `MACOS_PROVISIONING_PROFILE` or the `APPLE_TEAM_ID` variable. They exist only for T3's
passkey entitlement, and the fork's workflow never uses them.

The repo is public. GitHub doesn't pass secrets to workflows triggered by pull requests from
forks, so the release jobs must never run on `pull_request_target`.

### 1.6 macOS gotchas

- Team members on the current ad-hoc-signed fork build must install the **first signed build
  manually** from the DMG. An ad-hoc signature's designated requirement is its own cdhash, so it
  can't accept a differently signed update. Later updates install automatically.
- The first launch of a build signed by a new team triggers a one-off Keychain prompt for
  "t3code Safe Storage". Choose _Always Allow_.
- `spctl` shows the result as "Notarized Developer ID". The first-launch dialog for a downloaded
  notarized app is a normal "downloaded from the Internet" confirmation, with no "unidentified
  developer" block.

## 2. Windows: Azure Artifact Signing

### 2.1 Eligibility (checked 2026-09-26)

Microsoft's quickstart, _Prerequisites_ note
(<https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart>), says:

> "Public Trust certificates are available to organizations in the United States, Canada, the
> European Union, the United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore,
> Switzerland, Norway, and Israel. Individual developers must be located in the United States or
> Canada. These geographic restrictions do not apply to Private Trust certificates."

- **Wingman AI Pty Ltd (an Australian organisation) is eligible** for Public Trust signing, which
  is what SmartScreen and Smart App Control trust.
- **Seth as an Australian individual is not eligible.** Private Trust has no geographic limit, but
  it isn't trusted by Windows out of the box, so it's useless here.
- The FAQ (<https://learn.microsoft.com/en-us/azure/artifact-signing/faq>) says it "doesn't support
  free, trial, or sponsored Azure subscriptions", so you need a paid (Pay-As-You-Go) subscription.
  It also warns that if organisation validation can't be completed, Microsoft "can't onboard you".
  In that case delete the account so you stop being billed, and use section 2.6.

### 2.2 Setup

1. **Azure account:** <https://portal.azure.com>. Sign up with a company email, which creates the
   Entra tenant, and upgrade to a **Pay-As-You-Go** subscription.
2. **Register the provider:** Subscriptions → your subscription → Settings → _Resource providers_
   → `Microsoft.CodeSigning` → _Register_.
3. **Create the account:** Create a resource → search "Artifact Signing" → _Artifact Signing
   Account_.
   - Create a new resource group `rg-t3code-signing`.
   - Name it e.g. `wingman-signing`: 3–24 letters, digits or hyphens, globally unique, starting
     with a letter.
   - Pricing tier **Basic**.
   - Region: there is no Australian region. Pick **East US**, where most GitHub-hosted runners
     are. Its endpoint is `https://eus.codesigning.azure.net`. The account's _Overview_ shows the
     endpoint as the Account URI.
4. **Allow yourself to validate:** open the account → _Access control (IAM)_ → _Add role
   assignment_ → **Artifact Signing Identity Verifier** → assign it to yourself. The role
   requires at least Reader on the subscription, which the subscription owner has.
5. **Identity validation:** account → _Identity validations_ → _New identity_ → **Public** →
   **Organization**:
   - Organization name: the exact legal name on the ASIC register (`Wingman AI Pty Ltd`).
   - Website.
   - Primary and secondary email: two different mailboxes on the company domain, both able to
     receive external links.
   - Business identifier: the ABN (or ACN).
   - Business address.
   - The representative's first and last name, exactly as on your photo ID.

   Check the **Certificate subject preview**. Its CN is the publisher name used in step 9. Then:
   - Click the verification email link within 7 days.
   - When the status shows _Action Required_, complete the Verified ID check (Microsoft
     Authenticator, government photo ID and a face check).
   - If Microsoft asks for documents (e.g. an ASIC company extract), they must be issued within
     the last 12 months. You get **three upload attempts**.

6. **Certificate profile** (once validation shows _Completed_): account → _Certificate profiles_
   → _Create_ → **Public Trust** → name `t3code` → select the validated identity.
7. **App registration (CI identity):** Microsoft Entra ID → _App registrations_ → _New
   registration_ → name `t3code-release-signing`, single tenant, no redirect URI.
   - Copy the **Application (client) ID** and the **Directory (tenant) ID**.
   - _Certificates & secrets_ → _New client secret_ (24 months maximum). Copy the **Value**
     column immediately. It's shown once. Don't copy the _Secret ID_ GUID.
8. **Grant signing:** Artifact Signing account (or just the certificate profile) → _Access control
   (IAM)_ → _Add role assignment_ → **Artifact Signing Certificate Profile Signer** → assign it to
   the service principal `t3code-release-signing`. The role names are listed at
   <https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles>.
9. **Store the secrets:** run `scripts/fork/set-signing-secrets.sh --windows`. It checks the
   client credentials against Entra ID before setting anything.

The secret names keep the old "Trusted Signing" wording because the upstream pipeline reads them:

| Secret                                           | Value                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `AZURE_TENANT_ID`                                | Directory (tenant) ID (GUID)                                     |
| `AZURE_CLIENT_ID`                                | Application (client) ID (GUID)                                   |
| `AZURE_CLIENT_SECRET`                            | client secret **Value**                                          |
| `AZURE_TRUSTED_SIGNING_ENDPOINT`                 | Account URI, e.g. `https://eus.codesigning.azure.net`            |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`             | account name, e.g. `wingman-signing`                             |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | profile name, e.g. `t3code`                                      |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`           | the certificate subject's CN, exactly, e.g. `Wingman AI Pty Ltd` |

The publisher name is written into `app-update.yml`. electron-updater refuses any later Windows
update whose Authenticode signer doesn't match it.

### 2.3 Costs

- Basic is **US$9.99/month**, including 5,000 signatures per month. Extra signatures cost
  US$0.005 each. Premium, at US$99.99, isn't needed. Prices come from the Azure retail prices
  API (service "Trusted Signing"); see also
  <https://azure.microsoft.com/pricing/details/artifact-signing/>.
- The FAQ says billing is "not calculated on a pro rata basis". The full month is charged from
  account creation, even while validation is pending.
- Identity validation and the certificates cost nothing extra. Certificates are short-lived and
  renewed automatically. The identity validation itself expires and must be renewed; Microsoft
  emails reminders from 60 days out.

### 2.4 Until Windows is signed

The upstream workflow silently builds Windows **unsigned** while any Azure secret is missing
("Windows signing disabled"), so Windows can ship before Azure is ready. What users see:

- **First install:** a browser-downloaded installer carries Mark-of-the-Web, so SmartScreen shows
  "Windows protected your PC / Unknown publisher". Users click _More info → Run anyway_. The
  browser may also warn that the file is "not commonly downloaded".
- **Smart App Control:** on Windows 11 PCs where it's _On_, it blocks unsigned apps with no
  per-app override. Microsoft's article
  (<https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003>)
  says "If the app is unsigned, or the signature is invalid, Smart App Control will consider it
  untrusted and block it" and "There is currently no way to bypass Smart App Control protection
  for individual apps". Affected teammates would have to turn Smart App Control off in Windows
  Security. Recent Windows updates let it be turned back on without a clean install.
- **Auto-updates still install:**
  - electron-builder writes `publisherName` into `app-update.yml` only when it can compute one.
    For Azure that is `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`; unsigned builds get none
    (app-builder-lib 26.15.6, `PublishManager`).
  - electron-updater's `NsisUpdater.verifySignature` returns early when `publisherName` is absent
    (electron-updater 6.8.3), so unsigned NSIS updates install without a signature check.
  - The updater downloads with its own HTTP client, so updates carry no Mark-of-the-Web and
    SmartScreen doesn't prompt for them.
- **Moving from unsigned to signed:** the first signed release installs over an unsigned one
  without trouble. From then on the installed `app-update.yml` pins the publisher, so every later
  update must be signed with that CN, or the update is rejected as "not signed by the application
  owner". If the signing provider or legal name ever changes, ship one bridging release whose
  `publisherName` lists both names; electron-updater accepts an array.
- Signed builds can still see SmartScreen warnings for their first downloads until reputation
  accrues. The FAQ says the prompt "stops appearing once the file hash has sufficient download
  history".

### 2.5 Verification

In PowerShell, run:

```powershell
Get-AuthenticodeSignature .\T3-Code-*.exe | Format-List Status,SignerCertificate
```

Expect `Status: Valid` and a subject of `CN=Wingman AI Pty Ltd, …`. The installed app's
`resources\app-update.yml` should contain `publisherName`.

### 2.6 Fallback if Microsoft rejects the organisation

Use an **OV code-signing certificate held in a cloud HSM** that CI can drive unattended. Since
2023, CAs issue code-signing keys only on hardware, so a `.pfx` file isn't possible.

The most CI-friendly option is **SSL.com OV + eSigner**. Its `CodeSignTool` runs headless with a
stored TOTP secret. eSigner pricing (<https://www.ssl.com/guide/esigner-pricing-for-code-signing/>)
is US$20/month for 20 signings or US$85/month for 100. Every release signs several executables
per architecture (app, installer, uninstaller and bundled helper `.exe` files), so plan on the
100-signing tier plus the OV certificate itself. That is roughly 10× the cost of Azure.

DigiCert KeyLocker is also CI-friendly but priced by quote. Certum's cloud certificate is cheap,
but its SimplySign login is hard to automate.

The fork would need code changes, because upstream's build supports only Azure for Windows (not
implemented yet):

- `scripts/build-desktop-artifact.ts` (~line 2771): when the eSigner secrets exist, set
  `winConfig.signtoolOptions = { sign: "<repo>/scripts/fork/sign-windows-esigner.ts", publisherName: [<WIN_PUBLISHER_NAME>] }`.
  This is an upstream file, so the edit belongs in the extension host commit and is tagged `t3-ext`
  (FORK.md). `publisherName` must be explicit: with a custom `sign` hook electron-builder can't read the
  CN, so updates would go unverified.
- A new `scripts/fork/sign-windows-esigner.ts` hook runs `CodeSignTool sign … -input_file_path <file> -override`
  per file.
- `.github/workflows/fork-release.yml`: swap the _Prepare Azure Trusted Signing_ step for Java +
  CodeSignTool setup, and pass `--signed` when `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`,
  `ES_TOTP_SECRET` and `WIN_PUBLISHER_NAME` are set. Add an `--esigner` mode to `set-signing-secrets.sh`.

## 3. Verifying a signed macOS build

```bash
APP="/Applications/T3 Code (Alpha).app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -E 'Authority=Developer ID Application|TeamIdentifier'
spctl --assess --type execute -vv "$APP"      # expect: source=Notarized Developer ID
xcrun stapler validate "$APP"                   # expect: The validate action worked!
```

## 4. Expiry and rotation

| Item                                 | Lifetime                            | Action                                                                                            |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| Developer ID Application certificate | 5 years                             | Create a new one, re-export, and re-run the script. Already-notarized builds keep working.        |
| App Store Connect API key            | no expiry                           | Revoke it in App Store Connect if it leaks, then create a new one and re-run the script.          |
| Azure client secret                  | up to 24 months                     | Add a new secret before expiry and re-run `--windows`. An expired secret fails the Windows build. |
| Azure identity validation            | expires; reminders from 60 days out | Renew it in the portal, or certificate renewal and signing stop.                                  |
| Apple Developer membership           | yearly                              | Auto-renews. A lapsed membership stops notarization.                                              |
