import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const betaVersion = "0.1.0-beta.1";
const expectedPublishConfig = {
  access: "public",
  registry: "https://registry.npmjs.org/",
  tag: "beta",
};
const forbiddenMetadataFields = [
  "author",
  "contributors",
  "maintainers",
  "funding",
];
const forbiddenPackageExecutionFields = [
  "scripts",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];
const forbiddenCredentialPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,
  /\bpt_live_[a-f0-9]{32}\b/,
];

const packages = [
  {
    directory: "packages/cli",
    name: "proventools",
    binName: "proventools",
    private: false,
    repositoryDirectory: "packages/cli",
    declaredFiles: ["index.js", "README.md", "LICENSE", "skills"],
    archiveFiles: [
      "package/LICENSE",
      "package/README.md",
      "package/index.js",
      "package/package.json",
      "package/skills/proventools-cli/SKILL.md",
    ],
    verifyVersion(entryPoint, manifest) {
      const output = execFileSync(process.execPath, [entryPoint, "--version"], {
        encoding: "utf8",
      });
      assert.equal(output, `${manifest.version}\n`);
    },
  },
  {
    directory: "packages/mcp",
    name: "@proventools/mcp",
    binName: "proventools-mcp",
    private: true,
    repositoryDirectory: "packages/mcp",
    declaredFiles: ["index.js", "README.md", "LICENSE"],
    archiveFiles: [
      "package/LICENSE",
      "package/README.md",
      "package/index.js",
      "package/package.json",
    ],
    verifyVersion(entryPoint, manifest) {
      const output = execFileSync(process.execPath, [entryPoint], {
        encoding: "utf8",
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
      });
      const response = JSON.parse(output.trim());
      assert.equal(response.result.serverInfo.name, manifest.name);
      assert.equal(response.result.serverInfo.version, manifest.version);
    },
  },
];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertNoPersonalMetadata(manifest) {
  for (const field of forbiddenMetadataFields) {
    assert.equal(
      Object.hasOwn(manifest, field),
      false,
      `${manifest.name} must not expose ${field} metadata`,
    );
  }
}

function assertPublicProductMetadata(manifest, repositoryDirectory) {
  assertNoPersonalMetadata(manifest);
  assert.equal(manifest.homepage, "https://www.proventools.net");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/proventools/agent-clients.git",
    directory: repositoryDirectory,
  });
  assert.deepEqual(manifest.bugs, { url: "https://www.proventools.net/contact" });
  for (const field of forbiddenPackageExecutionFields) {
    assert.equal(
      Object.hasOwn(manifest, field),
      false,
      `${manifest.name} must remain dependency-free and cannot declare ${field}`,
    );
  }
}

test("the repository root cannot collide with or publish as a leaf package", async () => {
  const rootManifest = await readJson(path.join(repositoryRoot, "package.json"));
  const leafManifests = await Promise.all(
    packages.map(({ directory }) => readJson(path.join(repositoryRoot, directory, "package.json"))),
  );

  assert.equal(rootManifest.name, "proventools-private-workspace");
  assert.equal(rootManifest.private, true);
  assertNoPersonalMetadata(rootManifest);
  assert.equal(Object.hasOwn(rootManifest, "repository"), false);
  assert.equal(
    leafManifests.some(({ name }) => name === rootManifest.name),
    false,
    "the private workspace name must be distinct from every package name",
  );
});

for (const packageDefinition of packages) {
  test(`${packageDefinition.name} packs only its public runtime artifact`, async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "proventools-npm-package-"));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

    const artifactsDirectory = path.join(temporaryRoot, "artifacts");
    const extractionDirectory = path.join(temporaryRoot, "extracted");
    await mkdir(artifactsDirectory);
    await mkdir(extractionDirectory);

    const sourceDirectory = path.join(repositoryRoot, packageDefinition.directory);
    const sourceManifest = await readJson(path.join(sourceDirectory, "package.json"));
    assert.equal(sourceManifest.name, packageDefinition.name);
    assert.equal(sourceManifest.version, betaVersion);
    assert.equal(
      Object.hasOwn(sourceManifest, "private") ? sourceManifest.private : false,
      packageDefinition.private,
    );
    assert.equal(sourceManifest.license, "MIT");
    assert.equal(sourceManifest.engines.node, ">=22.14.0");
    assert.deepEqual(sourceManifest.files, packageDefinition.declaredFiles);
    assert.deepEqual(sourceManifest.publishConfig, expectedPublishConfig);
    assertPublicProductMetadata(sourceManifest, packageDefinition.repositoryDirectory);

    const npmOutput = execFileSync(
      "npm",
      [
        "--cache",
        path.join(temporaryRoot, "npm-cache"),
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        artifactsDirectory,
        sourceDirectory,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const [packResult] = JSON.parse(npmOutput);
    assert.equal(packResult.name, packageDefinition.name);
    assert.equal(packResult.version, sourceManifest.version);

    const archivePath = path.join(artifactsDirectory, packResult.filename);
    const archiveFiles = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(archiveFiles, packageDefinition.archiveFiles);

    execFileSync("tar", ["-xzf", archivePath, "-C", extractionDirectory]);
    const artifactRoot = path.join(extractionDirectory, "package");
    const artifactManifest = await readJson(path.join(artifactRoot, "package.json"));
    assert.equal(artifactManifest.name, sourceManifest.name);
    assert.equal(artifactManifest.version, sourceManifest.version);
    assert.equal(
      Object.hasOwn(artifactManifest, "private") ? artifactManifest.private : false,
      packageDefinition.private,
    );
    assert.equal(artifactManifest.license, "MIT");
    assert.equal(artifactManifest.engines.node, ">=22.14.0");
    assert.deepEqual(artifactManifest.files, packageDefinition.declaredFiles);
    assert.deepEqual(artifactManifest.publishConfig, expectedPublishConfig);
    assertPublicProductMetadata(artifactManifest, packageDefinition.repositoryDirectory);

    const artifactText = await Promise.all(
      packageDefinition.archiveFiles
        .filter((archiveFile) => !archiveFile.endsWith(".skill"))
        .map((archiveFile) =>
        readFile(path.join(extractionDirectory, archiveFile), "utf8"),
      ),
    );
    const combinedArtifactText = artifactText.join("\n");
    assert.doesNotMatch(combinedArtifactText, /(?:\/Users\/|\/home\/|[A-Z]:\\\\Users\\\\)/i);
    assert.doesNotMatch(
      combinedArtifactText,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    );
    for (const credentialPattern of forbiddenCredentialPatterns) {
      assert.doesNotMatch(combinedArtifactText, credentialPattern);
    }

    const expectedBinPath = sourceManifest.bin[packageDefinition.binName];
    assert.equal(expectedBinPath, "index.js");
    const entryPoint = path.join(artifactRoot, expectedBinPath);
    assert.notEqual((await stat(entryPoint)).mode & 0o111, 0, "the packaged bin must be executable");
    packageDefinition.verifyVersion(entryPoint, artifactManifest);

    const installPrefix = path.join(temporaryRoot, "install");
    execFileSync(
      "npm",
      [
        "--cache",
        path.join(temporaryRoot, "install-cache"),
        "install",
        "--global",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--prefix",
        installPrefix,
        archivePath,
      ],
      { cwd: temporaryRoot, encoding: "utf8" },
    );
    const installedBin = path.join(installPrefix, "bin", packageDefinition.binName);
    await access(installedBin);
    packageDefinition.verifyVersion(installedBin, artifactManifest);

    if (packageDefinition.name === "proventools") {
      const installedSkillDirectory = execFileSync(installedBin, ["skill-path"], {
        encoding: "utf8",
      }).trim();
      assert.equal(
        await realpath(installedSkillDirectory),
        await realpath(path.join(
          installPrefix,
          "lib",
          "node_modules",
          "proventools",
          "skills",
          "proventools-cli",
        )),
      );
      const installedSkill = await readFile(path.join(installedSkillDirectory, "SKILL.md"), "utf8");
      assert.match(installedSkill, /^---\nname: proventools-cli\n/);
      assert.match(installedSkill, /Never ask the user to paste an API key/);
    }
  });
}
