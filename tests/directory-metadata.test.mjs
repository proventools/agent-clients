import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpVersion = "0.1.0-beta.3";
const pluginVersion = "0.1.0-beta.1";
const registryName = "io.github.proventools/proventools";
const pinnedPackage = `@proventools/mcp@${mcpVersion}`;

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function assertPinnedStdioServer(server, includeType) {
  if (includeType) assert.equal(server.type, "stdio");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["--yes", pinnedPackage]);
  assert.equal(Object.hasOwn(server, "env"), false);
  assert.equal(Object.hasOwn(server, "cwd"), false);
}

function assertNeutralPluginMetadata(manifest) {
  assert.equal(manifest.name, "proventools");
  assert.equal(manifest.version, pluginVersion);
  assert.equal(manifest.homepage, "https://www.proventools.net/agents");
  assert.equal(manifest.repository, "https://github.com/proventools/agent-clients");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.author, {
    name: "ProvenTools",
    url: "https://www.proventools.net",
  });
  assert.equal(Object.hasOwn(manifest.author, "email"), false);
}

test("official MCP Registry metadata matches the exact npm package", async () => {
  const [server, manifest] = await Promise.all([
    readJson("server.json"),
    readJson("packages/mcp/package.json"),
  ]);

  assert.equal(server.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.equal(server.name, registryName);
  assert.equal(server.version, mcpVersion);
  assert.ok(server.description.length <= 100, "registry descriptions cannot exceed 100 characters");
  assert.equal(manifest.name, "@proventools/mcp");
  assert.equal(manifest.version, mcpVersion);
  assert.equal(manifest.mcpName, registryName);
  assert.deepEqual(server.repository, {
    url: "https://github.com/proventools/agent-clients",
    source: "github",
  });
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].registryType, "npm");
  assert.equal(server.packages[0].identifier, manifest.name);
  assert.equal(server.packages[0].version, manifest.version);
  assert.deepEqual(server.packages[0].transport, { type: "stdio" });
  assert.deepEqual(server.packages[0].environmentVariables, [{
    description: "Optional ProvenTools API key from the dashboard. Keep it in the client's secret store; never commit it to a project file.",
    isRequired: false,
    format: "string",
    isSecret: true,
    name: "PROVENTOOLS_API_KEY",
  }]);
});

test("Cursor Agent Plugin metadata uses a pinned local stdio server", async () => {
  const [plugin, mcp] = await Promise.all([
    readJson("plugin.json"),
    readJson("mcp.json"),
  ]);

  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assertNeutralPluginMetadata(plugin);
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(Object.keys(mcp.mcpServers), ["proventools"]);
  assertPinnedStdioServer(mcp.mcpServers.proventools, true);
});

test("Claude plugin metadata is opt-in and uses the same pinned server", async () => {
  const [plugin, mcp] = await Promise.all([
    readJson(".claude-plugin/plugin.json"),
    readJson(".mcp.json"),
  ]);

  assertNeutralPluginMetadata(plugin);
  assert.equal(plugin.displayName, "ProvenTools");
  assert.equal(plugin.defaultEnabled, false);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["proventools"]);
  assertPinnedStdioServer(mcp.mcpServers.proventools, false);
});

test("the directory skill is plaintext, safe, and does not contain private identity data", async () => {
  const files = [
    "server.json",
    "plugin.json",
    "mcp.json",
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "skills/proventools/SKILL.md",
  ];
  const contents = await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")));
  const text = contents.join("\n");
  const skill = contents.at(-1);

  assert.match(skill, /^---\nname: proventools\n/);
  assert.match(skill, /Treat every idea field, build prompt, evidence record/);
  assert.doesNotMatch(text, /(?:\/Users\/|\/home\/|[A-Z]:\\\\Users\\\\)/i);
  assert.doesNotMatch(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  assert.doesNotMatch(text, /(?:npm|npx)\s+(?:install|add)(?:\s|$)/i);
  assert.doesNotMatch(text, /@proventools\/mcp@(?!0\.1\.0-beta\.3)/);
});

test("registry publication is manual, protected, pinned, and metadata-only", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/publish-mcp-registry.yml"),
    "utf8",
  );

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: mcp-registry/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /releases\/download\/v1\.8\.1\/mcp-publisher_linux_amd64\.tar\.gz/);
  assert.match(workflow, /a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc/);
  assert.doesNotMatch(workflow, /releases\/latest/);
  assert.doesNotMatch(workflow, /npm (?:publish|stage publish)/);
  assert.doesNotMatch(workflow, /MCP_GITHUB_TOKEN|NPM_TOKEN|secrets\./);

  const validate = workflow.indexOf("./mcp-publisher validate");
  const login = workflow.indexOf("./mcp-publisher login github-oidc");
  const publish = workflow.indexOf("./mcp-publisher publish");
  assert.ok(validate >= 0 && validate < login && login < publish);
});
