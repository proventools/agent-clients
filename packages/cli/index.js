#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0-beta.1";
const API_KEY_PATTERN = /^pt_live_[a-f0-9]{32}$/;
const DEFAULT_API_ORIGIN = "https://www.proventools.net";
const TRUSTED_API_ORIGINS = new Set([
  "https://www.proventools.net",
  "https://proventools.net",
]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const configDirectory = path.join(os.homedir(), ".config", "proventools");
const configPath = path.join(configDirectory, "config.json");
const skillDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "skills",
  "proventools-cli",
);

class CliError extends Error {}

function apiBaseUrl() {
  const configured = (process.env.PROVENTOOLS_API_URL || DEFAULT_API_ORIGIN).trim();
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new CliError("PROVENTOOLS_API_URL must be a valid API origin.");
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliError("PROVENTOOLS_API_URL must contain an origin only, without credentials, a path, query, or fragment.");
  }

  const trustedProduction = TRUSTED_API_ORIGINS.has(url.origin);
  const safeLoopback = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!trustedProduction && !safeLoopback) {
    throw new CliError(
      "Refusing to send an API key to an untrusted origin. Use https://www.proventools.net, https://proventools.net, or HTTP on localhost, 127.0.0.1, or [::1] for local development."
    );
  }

  return url.origin;
}

async function readResponseText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new CliError("The ProvenTools API response exceeded the 2 MiB safety limit.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_API_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CliError("The ProvenTools API response exceeded the 2 MiB safety limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function responsePayload(response, responseType) {
  const text = await readResponseText(response);
  if (responseType === "text") return text;
  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) return null;
    throw new CliError("The ProvenTools API returned an invalid JSON response.");
  }
}

async function readConfig() {
  try {
    const value = JSON.parse(await readFile(configPath, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new CliError(`Could not read ${configPath}. Run “proventools login” to replace it.`);
  }
}

async function configuredApiKey() {
  const environmentKey = (process.env.PROVENTOOLS_API_KEY || "").trim();
  if (environmentKey) return environmentKey;
  const config = await readConfig();
  const key = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  if (!key) throw new CliError("Not logged in. Run “proventools login” or set PROVENTOOLS_API_KEY.");
  return key;
}

async function apiRequest(endpoint, options = {}) {
  const baseUrl = apiBaseUrl();
  const key = options.key || (await configuredApiKey());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1${endpoint}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: options.responseType === "text" ? "text/markdown" : "application/json",
        "User-Agent": `proventools-cli/${VERSION}`,
        "X-ProvenTools-Channel": "cli",
      },
      redirect: "error",
      signal: controller.signal,
    });
    const payload = await responsePayload(response, options.responseType);

    if (!response.ok) {
      const apiMessage = payload?.error?.message;
      if (response.status === 401) {
        throw new CliError(
          "Invalid API key. Create one at https://www.proventools.net/dashboard/api-keys and run “proventools login”."
        );
      }
      if (response.status === 403) {
        throw new CliError("API access requires the ProvenTools Live add-on.");
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        throw new CliError(
          `Rate limit reached${retryAfter ? `; retry in ${retryAfter}s` : "; retry shortly"}.`
        );
      }
      if (response.status === 503) {
        throw new CliError("ProvenTools API keys are not provisioned yet. Try again later.");
      }
      throw new CliError(apiMessage || `ProvenTools API request failed with status ${response.status}.`);
    }

    return payload;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (controller.signal.aborted) {
      throw new CliError(`The ProvenTools API request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new CliError(
      `Could not reach the ProvenTools API at ${baseUrl}. Check your network or PROVENTOOLS_API_URL.`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function promptForKey() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await input.question("API key: ")).trim();
    } finally {
      input.close();
    }
  }

  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write("\n");
      resolve(value.trim());
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write("\n");
      reject(new CliError("Login canceled."));
    };

    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cancel();
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          process.stdout.write("•");
        }
      }
    };

    process.stdout.write("API key: ");
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function login() {
  const key = await promptForKey();
  if (!API_KEY_PATTERN.test(key)) {
    throw new CliError("That does not look like a ProvenTools API key.");
  }

  process.stdout.write("Validating key…\n");
  await apiRequest("/ideas?limit=1", { key });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  process.stdout.write(`Logged in. Key stored in ${configPath} with owner-only permissions.\n`);
}

function terminalText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function truncate(value, width) {
  const text = terminalText(value).replace(/\s+/g, " ").trim();
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

function table(rows, columns) {
  const header = columns.map((column) => column.label.padEnd(column.width)).join("  ");
  const divider = columns.map((column) => "─".repeat(column.width)).join("  ");
  const body = rows.map((row) =>
    columns
      .map((column) => truncate(row[column.key], column.width).padEnd(column.width))
      .join("  ")
  );
  process.stdout.write(`${[header, divider, ...body].join("\n")}\n`);
}

async function search(query) {
  if (!query) throw new CliError("Usage: proventools search <query>");
  const params = new URLSearchParams({ search: query });
  const data = await apiRequest(`/ideas?${params}`);
  if (!data.items?.length) {
    process.stdout.write("No ideas found.\n");
    return;
  }
  table(data.items, [
    { key: "id", label: "ID", width: 36 },
    { key: "title", label: "TITLE", width: 42 },
    { key: "category", label: "CATEGORY", width: 24 },
    { key: "difficulty", label: "DIFFICULTY", width: 10 },
  ]);
  process.stdout.write(
    `\nPage ${terminalText(data.pagination.page)} of ${terminalText(data.pagination.totalPages)}\n`
  );
}

function section(label, value) {
  if (value === null || value === undefined || value === "") return;
  process.stdout.write(`\n${label}\n${"─".repeat(label.length)}\n${terminalText(value)}\n`);
}

async function show(id) {
  if (!id) throw new CliError("Usage: proventools show <id>");
  const data = await apiRequest(`/ideas/${encodeURIComponent(id)}`);
  const idea = data.item;
  const title = terminalText(idea.title);
  process.stdout.write(`${title}\n${"═".repeat(Math.min(title.length, 80))}\n`);
  process.stdout.write(`${terminalText(idea.category || "Uncategorized")} · ${terminalText(idea.difficulty || "Unrated")}`);
  if (idea.difficulty_score !== null) process.stdout.write(` · ${terminalText(idea.difficulty_score)}/10`);
  process.stdout.write(`\nID: ${terminalText(idea.id)}\n`);
  section("Description", idea.description);
  section("Problem", idea.problem);
  section("Solution", idea.solution);
  section("Target market", idea.target_market);
  section("Core features", idea.core_features);
  section("Value proposition", idea.value_props);
  section("Business model", idea.business_model);
  section("Technical notes", idea.tech_notes);
  section("Example flow", idea.example_flow);
}

function kebabTitle(title, id) {
  const kebab = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return kebab || `idea-${String(id).slice(0, 8)}`;
}

async function pull(id) {
  if (!id) throw new CliError("Usage: proventools pull <id>");
  const [detail, prompt] = await Promise.all([
    apiRequest(`/ideas/${encodeURIComponent(id)}`),
    apiRequest(`/ideas/${encodeURIComponent(id)}/prompt`, { responseType: "text" }),
  ]);
  const filename = `${kebabTitle(detail.item.title, id)}.prompt.md`;
  const outputPath = path.resolve(process.cwd(), filename);
  try {
    await writeFile(outputPath, prompt.endsWith("\n") ? prompt : `${prompt}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CliError(`Refusing to overwrite ./${filename}. Move or delete it, then retry.`);
    }
    throw error;
  }
  process.stdout.write(`Wrote ./${filename}\n`);
}

async function whatsNew() {
  const data = await apiRequest("/drops/latest");
  const title = terminalText(data.title);
  process.stdout.write(`${title}\n${"═".repeat(Math.min(title.length, 80))}\n`);
  process.stdout.write(`${terminalText(data.period)}\n${terminalText(data.intro || "")}\n\n`);
  if (!data.ideas?.length) {
    process.stdout.write("No ideas in this drop.\n");
    return;
  }
  table(data.ideas, [
    { key: "id", label: "ID", width: 36 },
    { key: "title", label: "TITLE", width: 48 },
    { key: "category", label: "CATEGORY", width: 28 },
  ]);
}

function help() {
  process.stdout.write(`ProvenTools CLI ${VERSION}

Usage:
  proventools login
  proventools search <query>
  proventools show <id>
  proventools pull <id>
  proventools whats-new
  proventools skill-path

Environment:
  PROVENTOOLS_API_KEY  Override the key stored by login
  PROVENTOOLS_API_URL  Use a trusted production origin or an HTTP loopback origin
`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "login":
      await login();
      break;
    case "search":
      await search(args.join(" ").trim());
      break;
    case "show":
      await show(args[0]);
      break;
    case "pull":
      await pull(args[0]);
      break;
    case "whats-new":
      await whatsNew();
      break;
    case "skill-path":
      process.stdout.write(`${skillDirectory}\n`);
      break;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      break;
    case "--help":
    case "-h":
    case undefined:
      help();
      break;
    default:
      throw new CliError(`Unknown command: ${command}. Run “proventools --help”.`);
  }
}

main().catch((error) => {
  const message = terminalText(
    error instanceof CliError ? error.message : "The command failed unexpectedly."
  );
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
