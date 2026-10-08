# UpgradeX

UpgradeX is a local CLI for inspecting supported Node.js and Express upgrades. It maps version evidence, reports rule findings with source locations and impact paths, previews deterministic edits, and can run the checks configured by a project.

> **Scope:** UpgradeX currently has focused migration analysis for Node.js 22 → 24 and Express 4 → 5. A clean scan is not a guarantee that an upgrade is safe. Review findings and run the target project's own checks.

## Install and run

```powershell
npx upgradex --help
npx upgradex scan
```

Or install it in a project:

```powershell
npm install --save-dev upgradex
npx upgradex scan --technology express --from 4 --to 5
```

`upgradex scan` scans the current directory; pass a path to scan another project. `upgradex scan .` remains an equivalent explicit form. In an interactive terminal, UpgradeX detects the project first, shows its declared technology surfaces, and offers matching supported upgrade paths. For example, detected Express 4 is offered as Express 4 → 5. React, Vite, and TypeScript are shown as detected surfaces with a clear message when upgrade rules are not available. In scripts and CI, pass explicit options and `--ci`.

## Commands

```text
upgradex scan [path] [--technology node|express --from VERSION --to VERSION]
               [--format human|json|sarif] [--output FILE] [--details] [--ci]
upgradex verify [path] [--only typecheck,build,test] [--timeout MS] [--ci]
upgradex migrate [path] --technology node|express --from VERSION --to VERSION
                 [--allow-dirty] [--timeout MS] [--ci]
```

- `scan` discovers version references and, when given a supported upgrade, evaluates the matching rule pack. Human output gives a concise Version Surface Map, what needs attention, the affected project area, suggested changes, and check status. Interactive users can review plain-language next steps first, then open deep technical evidence and impact paths when needed. JSON and SARIF retain the complete structured report for tooling.
- `verify` runs matching `typecheck`, `build`, and `test` scripts from the root `package.json`. It writes `upgradex.proof.json`. Project scripts execute with the project's permissions; review them before running verification.
- `migrate` previews supported deterministic edits and asks before applying them. It creates a backup, checks for dirty affected files, applies changes atomically while preserving file permissions, rescans, and records a proof. In `--ci` mode it is preview only and never changes files. Try migrations on a disposable copy first.

## Safety and privacy

Scans run locally. UpgradeX does not upload source code or send scan telemetry. `scan` and migration previews are read-only: they do not run project scripts or change files. Scans read bounded source, manifest, and supported configuration files for static analysis. Files matching built-in sensitive filename patterns and symlinks are skipped, common generated/build directories and Python virtual environments are excluded, and scan size/file-count limits apply. Findings and impact paths cover supported rules and statically resolved relationships; dynamic behavior and unresolved calls can be missed. Use `verify` to run project checks and approve `migrate` to apply supported edits.

`verify` deliberately runs the selected project scripts with your user permissions. `migrate` writes only after interactive approval; it backs up affected files first. Use a disposable project copy when reviewing an automated migration.

## Exit codes

- `0`: no high or critical scan finding, or verification has no failed, timed-out, or blocked check. Unconfigured checks remain inconclusive and are never counted as passed.
- `1`: a high or critical scan finding, or a failed/timed-out/blocked verification.
- `2`: invalid command arguments or a blocked migration operation.

Finding severity and verification outcomes are reported separately from the final status. `not_configured` checks are not treated as passed checks.

## Supported analysis

The 31 current built-in upgrade rules cover Node.js 22 → 24 and Express 4 → 5. Runtime/framework discovery also recognizes additional version surfaces, including React, Vite, and TypeScript; discovering a surface does not imply a migration rule pack exists for it. Analysis uses a bounded static source graph, so dynamic imports, generated code, reflection, and runtime behavior can remain unresolved. Review each report's blind spots.

## Local development

### Test the packed npm artifact on Windows

From the repository root, build a tarball and install that exact file in a clean temporary project:

```powershell
npm pack
$archive = (Resolve-Path .\upgradex-0.1.0.tgz).Path
$consumer = Join-Path $env:TEMP "upgradex-consumer"
New-Item -ItemType Directory -Force $consumer | Out-Null
Push-Location $consumer
npm init -y
npm install $archive
npx upgradex --version
npx upgradex --help
npx upgradex scan --help
npx upgradex scan --ci --format json
Pop-Location
```

The help commands should show usage without scanning or running project scripts. The final command should return JSON for the temporary consumer. To test actual findings and migrations, run the package acceptance suite below; it installs the tarball in a disposable project and uses the repository fixtures.

```powershell
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm run quality
npm run test:artifact
npm pack --dry-run
```

`npm run test:artifact` packs UpgradeX, installs it into fresh temporary projects, and checks the installed CLI, output formats, rule packs, migration preview, package boundary, passing and failing verifier results, and proof artifact. The verifier fixture runs only controlled `node` commands. The GitHub Actions workflow runs the quality and package checks on Linux and Windows with Node.js 22.13, 24, and 26, and audits production dependencies. The package requires Node.js 22.13 or newer. Before publishing, set the owner-approved license, license file, author/maintainer, and repository URL; `npm publish` runs `prepublishOnly`, which blocks the release if any are missing. Run `npm run prepublishOnly` yourself after setting those fields.
