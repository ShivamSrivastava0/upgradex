# UpgradeX — Software Upgrade & Change Intelligence

**Understand what a software upgrade could break before you ship it.**

UpgradeX is a Software Upgrade & Change Intelligence CLI that helps developers understand the potential impact of software version changes before they reach production.

Software upgrades are not just about installing a newer dependency version. A change can affect source code, APIs, framework behavior, runtime compatibility, dependencies, tests, and build processes.

UpgradeX analyzes supported upgrade paths to identify potentially breaking changes, map affected code, assess migration risks, preview supported code changes, and review verification evidence.

Instead of simply asking _"Is a newer version available?"_, UpgradeX helps answer the more important question:

**"What could this upgrade change, what might break, and what evidence do I have before shipping it?"**

[![npm version](https://img.shields.io/npm/v/upgradex)](https://www.npmjs.com/package/upgradex)
[![npm downloads](https://img.shields.io/npm/dm/upgradex)](https://www.npmjs.com/package/upgradex)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-brightgreen)](https://nodejs.org/)

**npm:** https://www.npmjs.com/package/upgradex  
**GitHub:** https://github.com/ShivamSrivastava0/upgradex

---

## Why UpgradeX?

Dependency update tools help developers discover and install newer versions. UpgradeX focuses on a different question: **what does changing a version mean for the codebase that actually uses it?**

UpgradeX aims to connect upgrade intelligence across multiple stages:

- **Version Analysis** — discover declared versions, dependency information, and supported upgrade paths.
- **Breaking Change Detection** — identify supported upgrade-related code patterns that may require attention.
- **Code Impact Analysis** — connect findings to affected files, symbols, and statically resolved relationships.
- **Migration Risk Assessment** — communicate finding severity, available evidence, unresolved relationships, and blind spots.
- **Migration Guidance** — review recommended changes and supported deterministic edits.
- **Upgrade Verification** — run configured checks and record their outcomes as evidence.
- **Machine-Readable Reports** — produce structured JSON and SARIF output for developer tooling and CI workflows.

Coverage depends on the selected technology, version range, available rules, and how much of the project's behavior can be resolved statically. UpgradeX does not claim to predict every possible runtime failure.

## Installation

### Run without a global installation

```bash
npx upgradex --help
npx upgradex scan
```

### Install globally

```bash
npm install -g upgradex
```

Then run:

```bash
upgradex --version
upgradex scan
```

### Install as a development dependency

```bash
npm install --save-dev upgradex
npx upgradex scan
```

**Requirements:** Node.js 22.13 or newer and npm.

---

## Getting Started

### Scan the current project

```bash
upgradex scan
```

UpgradeX scans the current directory by default. To scan another project, provide its path:

```bash
upgradex scan ../my-project
```

The explicit current-directory form is also supported:

```bash
upgradex scan .
```

In an interactive terminal, UpgradeX detects the project and its declared technology surfaces before offering matching supported upgrade paths.

Detected technologies do not automatically imply full upgrade-analysis support. For example, React, Vite, and TypeScript can be recognized as version surfaces even when a corresponding migration rule pack is not available.

### Analyze an Express upgrade

```bash
upgradex scan --technology express --from 4 --to 5
```

View detailed technical evidence and affected files:

```bash
upgradex scan --technology express --from 4 --to 5 --details
```

Run in CI mode:

```bash
upgradex scan --technology express --from 4 --to 5 --ci
```

Export structured results:

```bash
upgradex scan --technology express --from 4 --to 5 --format json
upgradex scan --technology express --from 4 --to 5 --format sarif
```

---

## Commands

```text
upgradex scan [path]
               [--technology node|express --from VERSION --to VERSION]
               [--format human|json|sarif]
               [--output FILE] [--details] [--ci]

upgradex verify [path]
                 [--only typecheck,build,test]
                 [--timeout MS] [--ci]

upgradex migrate [path]
                  --technology node|express
                  --from VERSION --to VERSION
                  [--allow-dirty] [--timeout MS] [--ci]
```

### `scan` — Upgrade impact analysis

Discovers version references and evaluates the applicable rule pack when a supported upgrade path is selected.

The human-readable report presents findings, affected project areas, suggested changes, verification status, and relevant limitations. Interactive users can review concise next steps before opening the deeper technical analysis.

Use `--details` for expanded evidence and impact paths. JSON and SARIF output preserve the structured findings for downstream tooling.

### `verify` — Run project checks

```bash
upgradex verify
```

UpgradeX runs matching `typecheck`, `build`, and `test` scripts configured in the root `package.json`.

Verification results are written to `upgradex.proof.json`.

**Security note:** Project scripts execute with your user permissions. Review the scripts before running verification.

### `migrate` — Preview and apply supported edits

```bash
upgradex migrate --technology express --from 4 --to 5
```

UpgradeX previews supported deterministic edits and asks for approval before applying them. It checks affected-file state, creates backups, applies edits atomically while preserving file permissions, rescans, and records proof.

In `--ci` mode, migration is preview-only and does not modify files.

Always try automated migrations on a disposable project copy first.

---

## Current Supported Analysis

UpgradeX is designed for the broader software upgrade and change intelligence problem, while its current analysis coverage remains technology- and rule-specific.

The current release includes **31 built-in upgrade rules** covering:

| Upgrade path    | Current support                                                    |
| --------------- | ------------------------------------------------------------------ |
| Node.js 22 → 24 | Focused migration analysis                                         |
| Express 4 → 5   | Focused migration analysis                                         |
| React           | Version-surface detection; migration rules not currently available |
| Vite            | Version-surface detection; migration rules not currently available |
| TypeScript      | Version-surface detection; migration rules not currently available |

Discovery of a technology or version does not mean that UpgradeX has comprehensive rules for it.

The analysis uses bounded static source inspection and a statically resolved code graph. Dynamic imports, reflection, generated code, unresolved calls, and runtime-dependent behavior may remain outside the analysis.

A clean report is **not a guarantee that an upgrade is safe**. Review the evidence and blind spots, then run the target project's own checks.

---

## UpgradeX V2 — Shadow Upgrade

**Planned for V2: deeper before-and-after upgrade validation.**

The longer-term direction for UpgradeX is to move beyond static upgrade analysis toward stronger evidence about what actually changes when a project is upgraded.

Planned V2 capabilities include:

### Shadow Upgrade

Compare baseline checks with checks performed against an upgraded version in a controlled workflow.

### Baseline Reliability Analysis

Repeat baseline checks to help distinguish existing failures and flaky tests from potential upgrade-related regressions.

### Before-and-After Comparison

Compare findings and verification outcomes before and after an upgrade to make changes easier to investigate.

### Upgrade Failure Attribution

Help investigate whether newly observed failures may be associated with the upgrade rather than pre-existing project problems.

### Expanded Migration Automation

Extend supported deterministic code transformations, with reviewable previews and controlled application.

### Stronger Upgrade Evidence

Bring together detected risks, verification results, and unresolved blind spots so developers can make better-informed upgrade decisions.

These are planned capabilities, not claims about the current V0.1 release. Shadow execution and before-and-after verification require appropriate test environments and controlled project execution; they cannot prove the absence of every possible defect.

---

## Safety and Privacy

UpgradeX is designed to analyze projects locally.

- Source code is not uploaded to a remote analysis service.
- Scan telemetry is not sent.
- Static scans and migration previews do not run project scripts or modify source files.
- Source inspection is bounded by supported file types, file-count limits, and size limits.
- Built-in sensitive filename patterns are excluded from scanning.
- Symlinks and common generated/build directories, including Python virtual environments, are excluded.
- Findings are limited to supported rules and relationships that can be resolved through static analysis.

`verify` intentionally executes selected project scripts using your current user permissions.

`migrate` writes changes only after approval, creates backups first, and limits edits to supported transformations.

Use disposable copies of important repositories when evaluating automated changes.

---

## CI and Exit Codes

Use explicit upgrade parameters and `--ci` in automated workflows:

```bash
upgradex scan --technology express --from 4 --to 5 --ci
```

Supported output formats include human-readable reports, JSON, and SARIF.

| Exit code | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `0`       | No high or critical scan finding, or verification has no failed, timed-out, or blocked checks |
| `1`       | A high or critical scan finding, or a failed, timed-out, or blocked verification              |
| `2`       | Invalid command arguments or a blocked migration operation                                    |

Finding severity and verification results are reported separately from the final status. Checks marked `not_configured` are not counted as passed; missing verification coverage can leave the result inconclusive.

---

## Local Development and Testing

Clone the repository:

```bash
git clone https://github.com/ShivamSrivastava0/upgradex.git
cd upgradex
npm install
```

Run the development quality checks:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run quality
```

Test the packed npm artifact:

```bash
npm run test:artifact
npm pack --dry-run
```

The package acceptance suite installs the generated tarball in fresh temporary projects and checks the installed CLI, report formats, supported rule packs, migration preview, package boundary, verifier outcomes, and proof artifact.

The verifier fixture uses controlled `node` commands.

The GitHub Actions workflow checks the project on Linux and Windows with supported Node.js versions and audits production dependencies.

### Test the packed artifact on Windows

From the repository root in PowerShell:

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

Replace `upgradex-0.1.0.tgz` if `npm pack` generates a tarball with a different version in its filename.

The help commands should show usage without scanning or running project scripts. The last command should return structured JSON for the temporary consumer project.

---

## Project Direction

UpgradeX is being developed around a broader goal:

**Make software upgrades more understandable, reviewable, and evidence-driven.**

The initial release establishes focused static analysis, impact reporting, migration previews, and verification evidence. The planned V2 direction extends that foundation toward controlled before-and-after validation and deeper upgrade outcome analysis.

The guiding principle is straightforward: **identify what may change, understand what may be affected, and gather evidence before shipping the upgrade.**

## Links

- **npm package:** https://www.npmjs.com/package/upgradex
- **Source code:** https://github.com/ShivamSrivastava0/upgradex
- **Issues and feedback:** https://github.com/ShivamSrivastava0/upgradex/issues
