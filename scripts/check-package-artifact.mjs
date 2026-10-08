import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const npmCli = process.env.npm_execpath;

assert.ok(
  npmCli,
  "Run this check through an npm script so npm_execpath exists.",
);

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: "1", ...options.env },
  });
  if (result.error) throw result.error;
  return result;
}

function runNpm(args, cwd) {
  const result = runNode([npmCli, ...args], { cwd });
  assert.equal(
    result.status,
    0,
    `npm ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function runCli(cliPath, args, cwd) {
  return runNode([cliPath, ...args], { cwd });
}

const scratchRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "upgradex-package-acceptance-"),
);

try {
  const releaseGate = runNode(
    [path.join(root, "scripts", "check-release-metadata.mjs")],
    { cwd: root },
  );
  assert.ok(
    releaseGate.status === 0 || releaseGate.status === 1,
    `Release metadata preflight crashed:\n${releaseGate.stderr}`,
  );
  assert.ok(
    releaseGate.status === 0
      ? releaseGate.stdout.includes("Public release metadata is complete.")
      : releaseGate.stderr.includes("Public release preflight blocked."),
    "Release metadata preflight did not explain its result.",
  );

  const packOutput = runNpm(
    ["pack", "--json", "--pack-destination", scratchRoot],
    root,
  );
  const packData = JSON.parse(packOutput);
  const packed = Array.isArray(packData)
    ? packData[0]
    : (packData[packageMetadata.name] ?? packData);
  assert.ok(packed?.filename, "npm pack did not return an artifact filename.");
  const packagedPaths = packed.files.map((file) =>
    file.path.replaceAll("\\", "/"),
  );
  for (const entry of packagedPaths) {
    assert.ok(
      !/^(?:apps|src|tests|fixtures|scripts)\//.test(entry),
      `Development file leaked into the package: ${entry}`,
    );
  }
  assert.ok(packagedPaths.includes("README.md"));
  assert.ok(packagedPaths.some((entry) => entry.startsWith("dist/apps/cli/")));
  assert.ok(packagedPaths.some((entry) => entry.startsWith("rules/")));
  const declaredLicense =
    typeof packageMetadata.license === "string" ? packageMetadata.license : "";
  if (declaredLicense.startsWith("SEE LICENSE IN ")) {
    const licensePath = declaredLicense
      .slice("SEE LICENSE IN ".length)
      .replaceAll("\\", "/");
    assert.ok(
      packagedPaths.includes(licensePath),
      `The custom license file is missing from the tarball: ${licensePath}`,
    );
  } else if (declaredLicense && declaredLicense !== "UNLICENSED") {
    assert.ok(
      packagedPaths.some((entry) =>
        /^(?:LICENSE(?:\.(?:md|txt))?|COPYING(?:\.txt)?)$/i.test(entry),
      ),
      "The license/copyright file is missing from the tarball.",
    );
  }

  const projectRoot = path.join(scratchRoot, "consumer");
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "upgradex-artifact-consumer", private: true }),
  );
  runNpm(
    [
      "install",
      path.join(scratchRoot, packed.filename),
      "--no-audit",
      "--no-fund",
    ],
    projectRoot,
  );

  const installedPackage = path.join(
    projectRoot,
    "node_modules",
    packageMetadata.name,
  );
  const installedMetadata = JSON.parse(
    fs.readFileSync(path.join(installedPackage, "package.json"), "utf8"),
  );
  assert.equal(installedMetadata.version, packageMetadata.version);
  assert.equal(installedMetadata.engines?.node, packageMetadata.engines.node);
  const cliPath = path.join(
    installedPackage,
    "dist",
    "apps",
    "cli",
    "index.js",
  );

  const version = runCli(cliPath, ["--version"], projectRoot);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageMetadata.version);

  for (const [args, usage] of [
    [["--help"], "upgradex <command>"],
    [["scan", "--help"], "upgradex scan"],
    [["verify", "--help"], "upgradex verify"],
    [["migrate", "--help"], "upgradex migrate"],
  ]) {
    const result = runCli(cliPath, args, projectRoot);
    assert.equal(
      result.status,
      0,
      `${args.join(" ")} should exit successfully.`,
    );
    assert.ok(
      result.stdout.includes(usage),
      `${args.join(" ")} showed no usage.`,
    );
    assert.ok(
      !result.stdout.includes("Version Surface Map"),
      `${args.join(" ")} unexpectedly ran a scan.`,
    );
  }
  assert.ok(
    !fs.existsSync(path.join(projectRoot, "upgradex.proof.json")),
    "A verify help request unexpectedly ran verification.",
  );

  const currentDirectoryScan = runCli(cliPath, ["scan", "--ci"], projectRoot);
  assert.equal(currentDirectoryScan.status, 0);
  const currentDirectoryReport = JSON.parse(
    runCli(cliPath, ["scan", "--ci", "--format", "json"], projectRoot).stdout,
  );
  assert.equal(currentDirectoryReport.project.root, projectRoot);
  assert.equal(currentDirectoryReport.finalStatus, "OVERVIEW ONLY");

  const explicitCurrentDirectoryScan = runCli(
    cliPath,
    ["scan", ".", "--ci"],
    projectRoot,
  );
  assert.equal(explicitCurrentDirectoryScan.status, 0);
  assert.ok(
    explicitCurrentDirectoryScan.stdout.includes("No upgrade selected yet."),
  );

  const invalidOption = runCli(
    cliPath,
    ["scan", "--invalid-artifact-test-option"],
    projectRoot,
  );
  assert.equal(invalidOption.status, 2);
  assert.ok(invalidOption.stderr.includes("Unknown option"));

  const fixture = (...segments) => path.join(root, "fixtures", ...segments);
  const expressRoot = fixture("rule-express-positive");
  const expressHuman = runCli(
    cliPath,
    [
      "scan",
      expressRoot,
      "--technology",
      "express",
      "--from",
      "4",
      "--to",
      "5",
      "--ci",
      "--details",
    ],
    projectRoot,
  );
  assert.equal(expressHuman.status, 1);
  assert.ok(expressHuman.stdout.includes("Impact graph:"));
  assert.match(expressHuman.stdout, /at src\/legacy\.js:\d+:\d+/);

  const expressSummary = runCli(
    cliPath,
    [
      "scan",
      expressRoot,
      "--technology",
      "express",
      "--from",
      "4",
      "--to",
      "5",
      "--ci",
    ],
    projectRoot,
  );
  assert.equal(expressSummary.status, 1);
  assert.match(expressSummary.stdout, /7 issue\(s\) found/);
  assert.ok(!expressSummary.stdout.includes("Impact graph:"));

  const expressJson = runCli(
    cliPath,
    [
      "scan",
      expressRoot,
      "--technology",
      "express",
      "--from",
      "4",
      "--to",
      "5",
      "--ci",
      "--format",
      "json",
    ],
    projectRoot,
  );
  assert.equal(expressJson.status, 1);
  const jsonReport = JSON.parse(expressJson.stdout);
  assert.equal(jsonReport.schemaVersion, 1);
  assert.ok(jsonReport.findings.length > 0);

  const expressSarif = runCli(
    cliPath,
    [
      "scan",
      expressRoot,
      "--technology",
      "express",
      "--from",
      "4",
      "--to",
      "5",
      "--ci",
      "--format",
      "sarif",
    ],
    projectRoot,
  );
  assert.equal(expressSarif.status, 1);
  assert.equal(JSON.parse(expressSarif.stdout).version, "2.1.0");

  const nodeScan = runCli(
    cliPath,
    [
      "scan",
      fixture("rule-node-positive"),
      "--technology",
      "node",
      "--from",
      "22",
      "--to",
      "24",
      "--ci",
      "--details",
    ],
    projectRoot,
  );
  assert.equal(nodeScan.status, 1);
  assert.ok(nodeScan.stdout.includes("NODE24-"));

  const cleanScan = runCli(
    cliPath,
    ["scan", fixture("framework-false-positive"), "--ci"],
    projectRoot,
  );
  assert.equal(cleanScan.status, 0);
  assert.ok(cleanScan.stdout.includes("No upgrade selected yet."));

  const verificationRoot = path.join(scratchRoot, "verification-fixture");
  fs.mkdirSync(verificationRoot);
  fs.writeFileSync(
    path.join(verificationRoot, "package.json"),
    JSON.stringify({
      name: "upgradex-verification-fixture",
      private: true,
      scripts: {
        typecheck: "node --version",
        build: "node --version",
        test: "node --version",
      },
    }),
  );
  const verification = runCli(
    cliPath,
    ["verify", verificationRoot, "--ci", "--format", "json"],
    projectRoot,
  );
  assert.equal(
    verification.status,
    0,
    `Installed verifier failed:\n${verification.stdout}\n${verification.stderr}`,
  );
  const verificationReport = JSON.parse(verification.stdout);
  assert.deepEqual(
    verificationReport.verification.map(({ kind, status }) => ({
      kind,
      status,
    })),
    [
      { kind: "typecheck", status: "passed" },
      { kind: "build", status: "passed" },
      { kind: "test", status: "passed" },
    ],
  );
  const proofPath = path.join(verificationRoot, "upgradex.proof.json");
  assert.ok(fs.existsSync(proofPath), "verify did not write a proof file.");
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.project.name, "upgradex-verification-fixture");
  assert.equal(proof.verification.length, 3);
  assert.ok(proof.verification.every(({ status }) => status === "passed"));
  assert.ok(
    proof.verification.every(
      (result) => !("stdoutSummary" in result) && !("stderrSummary" in result),
    ),
    "Proof unexpectedly contains captured command output.",
  );

  fs.writeFileSync(
    path.join(verificationRoot, "package.json"),
    JSON.stringify({
      name: "upgradex-verification-fixture",
      private: true,
      scripts: { test: "node --upgradex-invalid-option" },
    }),
  );
  const failedVerification = runCli(
    cliPath,
    ["verify", verificationRoot, "--ci", "--only", "test", "--format", "json"],
    projectRoot,
  );
  assert.equal(
    failedVerification.status,
    1,
    "A failing project check should produce a failing CLI exit code.",
  );
  const failedReport = JSON.parse(failedVerification.stdout);
  assert.equal(failedReport.verification.length, 1);
  assert.equal(failedReport.verification[0].kind, "test");
  assert.equal(failedReport.verification[0].status, "failed");
  const failedProof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  assert.equal(failedProof.run.status, "BLOCKED");
  assert.equal(failedProof.verification[0].status, "failed");

  const migrationRoot = path.join(scratchRoot, "migration-fixture");
  fs.cpSync(fixture("rule-node-positive"), migrationRoot, { recursive: true });
  const migrationSource = path.join(migrationRoot, "src", "legacy.js");
  const originalSource = fs.readFileSync(migrationSource, "utf8");
  const migrationPreview = runCli(
    cliPath,
    [
      "migrate",
      migrationRoot,
      "--technology",
      "node",
      "--from",
      "22",
      "--to",
      "24",
      "--ci",
    ],
    projectRoot,
  );
  assert.equal(migrationPreview.status, 0);
  assert.ok(migrationPreview.stdout.includes("Migration preview"));
  assert.ok(migrationPreview.stdout.includes("Preview only"));
  assert.equal(fs.readFileSync(migrationSource, "utf8"), originalSource);

  process.stdout.write(
    `Installed package acceptance passed (${packed.files.length} files, ${jsonReport.findings.length} Express findings).\n`,
  );
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
