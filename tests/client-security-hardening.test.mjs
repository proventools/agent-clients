import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const API_KEY = `pt_live_${"a".repeat(32)}`;

function childEnvironment(overrides = {}) {
  return {
    ...process.env,
    PROVENTOOLS_API_KEY: API_KEY,
    ...overrides,
  };
}

async function runProcess(args, { cwd = ROOT, env = {}, input = "" } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function startMcp({ env = {}, nodeArgs = [] } = {}) {
  const child = spawn(
    process.execPath,
    [...nodeArgs, "packages/mcp/index.js"],
    {
      cwd: ROOT,
      env: childEnvironment(env),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let stderr = "";
  const messages = [];
  const waiters = [];

  function deliver(message) {
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index === -1) {
      messages.push(message);
      return;
    }
    const [{ resolve, timer }] = waiters.splice(index, 1);
    clearTimeout(timer);
    resolve(message);
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) deliver(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return {
    child,
    send(value) {
      const data = Buffer.isBuffer(value)
        ? value
        : typeof value === "string"
          ? value
          : `${JSON.stringify(value)}\n`;
      return new Promise((resolve, reject) => {
        child.stdin.write(data, (error) => error ? reject(error) : resolve());
      });
    },
    waitFor(predicate, timeoutMs = 3_000) {
      const existing = messages.findIndex(predicate);
      if (existing !== -1) return Promise.resolve(messages.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for MCP output. stderr: ${stderr}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
    async close() {
      child.stdin.end();
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve({ messages, stderr });
          else reject(new Error(`MCP exited ${code}. stderr: ${stderr}`));
        });
      });
    },
  };
}

function toolCall(id, name, args = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

test("CLI refuses attacker-controlled API origins before sending a bearer key", async () => {
  for (const origin of [
    "http://example.com",
    "https://staging.example.com",
    "https://www.proventools.net.example.com",
    "https://user:password@www.proventools.net",
    "https://www.proventools.net/unexpected",
    "https://www.proventools.net/#fragment",
    "https://localhost:8443",
  ]) {
    const result = await runProcess(
      ["packages/cli/index.js", "search", "security"],
      { env: { PROVENTOOLS_API_URL: origin } },
    );
    assert.equal(result.code, 1, origin);
    assert.match(result.stderr, /valid API origin|origin only|untrusted origin/i, origin);
  }
});

test("CLI permits HTTP only on explicit loopback and neutralizes terminal controls", async (t) => {
  let authorization;
  const api = await listen((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      items: [{
        id: "idea-1",
        title: "\u001b[31mInjected title",
        category: "Security",
        difficulty: "Easy",
      }],
      pagination: { page: 1, totalPages: 1 },
    }));
  });
  t.after(api.close);

  const result = await runProcess(
    ["packages/cli/index.js", "search", "security"],
    { env: { PROVENTOOLS_API_URL: api.origin } },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(authorization, `Bearer ${API_KEY}`);
  assert.doesNotMatch(result.stdout, /\u001b/);
  assert.match(result.stdout, /Injected title/);
});

test("CLI keeps pull-file content raw while terminal output remains sanitized", async (t) => {
  const rawPrompt = "# Build prompt\n\u001b[31mKeep raw control data\u001b[0m\n";
  const api = await listen((request, response) => {
    if (request.url.endsWith("/prompt")) {
      response.setHeader("content-type", "text/markdown");
      response.end(rawPrompt);
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ item: { id: "idea-1", title: "Raw prompt" } }));
  });
  const directory = await mkdtemp(path.join(tmpdir(), "proventools-cli-security-"));
  t.after(async () => {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  });

  const result = await runProcess(
    [path.join(ROOT, "packages/cli/index.js"), "pull", "idea-1"],
    { cwd: directory, env: { PROVENTOOLS_API_URL: api.origin } },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(path.join(directory, "raw-prompt.prompt.md"), "utf8"), rawPrompt);

  const secondResult = await runProcess(
    [path.join(ROOT, "packages/cli/index.js"), "pull", "idea-1"],
    { cwd: directory, env: { PROVENTOOLS_API_URL: api.origin } },
  );
  assert.equal(secondResult.code, 1);
  assert.match(secondResult.stderr, /refusing to overwrite/i);
  assert.equal(await readFile(path.join(directory, "raw-prompt.prompt.md"), "utf8"), rawPrompt);
});

test("MCP parses split UTF-8 and CRLF frames, handles multiple frames, and ignores notifications", async () => {
  const client = startMcp();
  const notification = Buffer.from(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: { label: "café" },
    })}\r\n`,
  );
  const splitAt = notification.indexOf(Buffer.from("é")) + 1;
  await client.send(notification.subarray(0, splitAt));
  await client.send(notification.subarray(splitAt));
  await client.send(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\r\n`
    + `${JSON.stringify({ jsonrpc: "2.0", method: "ping" })}\n`
    + `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
  );
  assert.deepEqual((await client.waitFor((message) => message.id === 1)).result, {});
  assert.deepEqual((await client.waitFor((message) => message.id === 2)).result, {});
  const { messages } = await client.close();
  assert.equal(messages.length, 0, "notifications must not produce responses");
});

test("MCP rejects an overlong no-newline frame without losing the next request", async () => {
  const client = startMcp();
  await client.send(Buffer.alloc(256 * 1024 + 1, 0x61));
  const oversized = await client.waitFor((message) => message.error?.code === -32600);
  assert.match(oversized.error.message, /256 KiB MCP message limit/);
  await client.send(`\n${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`);
  assert.deepEqual((await client.waitFor((message) => message.id === 9)).result, {});
  await client.close();
});

test("MCP refuses untrusted origins before an API key can leave the process", async () => {
  const client = startMcp({ env: { PROVENTOOLS_API_URL: "https://attacker.example" } });
  await client.send(toolCall(1, "search_ideas", { query: "security" }));
  const response = await client.waitFor((message) => message.id === 1);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /untrusted origin/i);
  await client.close();
});

test("MCP refuses redirects even when the redirect target is another loopback URL", async (t) => {
  let redirectedRequestReached = false;
  let api;
  api = await listen((request, response) => {
    if (request.url === "/redirected") {
      redirectedRequestReached = true;
      response.end("unexpected");
      return;
    }
    response.statusCode = 302;
    response.setHeader("location", `${api.origin}/redirected`);
    response.end();
  });
  t.after(api.close);
  const client = startMcp({ env: { PROVENTOOLS_API_URL: api.origin } });
  await client.send(toolCall(1, "get_credit_balance"));
  const response = await client.waitFor((message) => message.id === 1);
  assert.equal(response.result.isError, true);
  assert.equal(redirectedRequestReached, false);
  await client.close();
});

test("MCP preserves quote-first credit behavior and idempotency headers", async (t) => {
  let received;
  const api = await listen(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    received = {
      method: request.method,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      body: JSON.parse(Buffer.concat(body).toString("utf8")),
    };
    response.statusCode = 409;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      quoteRequired: true,
      creditCost: 3,
      quote: {
        id: "quote-1",
        approvalUrl: "/dashboard/live/credit-quotes/quote-1",
      },
    }));
  });
  t.after(api.close);
  const client = startMcp({ env: { PROVENTOOLS_API_URL: api.origin } });
  await client.send(toolCall(1, "request_evidence_refresh", {
    id: "idea-1",
    reason: "Recheck demand",
    idempotencyKey: "stable-operation-key",
  }));
  const response = await client.waitFor((message) => message.id === 1);
  assert.notEqual(response.result.isError, true);
  assert.deepEqual(received, {
    method: "POST",
    authorization: `Bearer ${API_KEY}`,
    idempotencyKey: "stable-operation-key",
    body: { reason: "Recheck demand" },
  });
  const toolResult = JSON.parse(response.result.content[0].text);
  assert.equal(toolResult.quoteRequired, true);
  assert.equal(toolResult.creditCost, 3);
  assert.equal(toolResult.customerActionRequired, true);
  assert.match(toolResult.message, /nothing has been spent/);
  assert.match(toolResult.message, /same idempotencyKey and quoteId/);
  await client.close();
});

test("MCP caps concurrency at four in-flight tool calls", async (t) => {
  const waitingResponses = [];
  let received = 0;
  let fourReceived;
  const ready = new Promise((resolve) => { fourReceived = resolve; });
  const api = await listen((_request, response) => {
    received += 1;
    waitingResponses.push(response);
    if (received === 4) fourReceived();
  });
  t.after(api.close);
  const client = startMcp({ env: { PROVENTOOLS_API_URL: api.origin } });

  for (let id = 1; id <= 5; id += 1) {
    await client.send(toolCall(id, "search_ideas", { query: `query-${id}` }));
  }
  await ready;
  const saturated = await client.waitFor((message) => message.id === 5);
  assert.equal(saturated.result.isError, true);
  assert.match(saturated.result.content[0].text, /allows 4 at a time/);
  assert.equal(received, 4);

  for (const response of waitingResponses) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      items: [],
      pagination: { page: 1, totalPages: 0 },
    }));
  }
  for (let id = 1; id <= 4; id += 1) {
    const response = await client.waitFor((message) => message.id === id);
    assert.notEqual(response.result.isError, true);
  }
  await client.close();
});

test("MCP bounds decompressed upstream bytes and agent-facing tool output", async (t) => {
  const oversized = gzipSync(JSON.stringify({ value: "x".repeat(2 * 1024 * 1024 + 1) }));
  const api = await listen((request, response) => {
    if (request.url.startsWith("/api/v1/ideas")) {
      response.setHeader("content-type", "application/json");
      response.setHeader("content-encoding", "gzip");
      response.end(oversized);
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ value: "x".repeat(129 * 1024) }));
  });
  t.after(api.close);
  const client = startMcp({ env: { PROVENTOOLS_API_URL: api.origin } });

  await client.send(toolCall(1, "search_ideas", { query: "security" }));
  const responseLimit = await client.waitFor((message) => message.id === 1);
  assert.equal(responseLimit.result.isError, true);
  assert.match(responseLimit.result.content[0].text, /2 MiB safety limit/);

  await client.send(toolCall(2, "get_credit_balance"));
  const outputLimit = await client.waitFor((message) => message.id === 2);
  assert.equal(outputLimit.result.isError, true);
  assert.match(outputLimit.result.content[0].text, /128 KiB agent-output safety limit/);
  await client.close();
});

test("MCP aborts API requests at the fixed request deadline", async () => {
  const preload = `data:text/javascript,${encodeURIComponent(`
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) =>
      originalSetTimeout(callback, delay === 20_000 ? 10 : delay, ...args);
    globalThis.fetch = (_url, options) => Promise.resolve(new Response(
      new ReadableStream({
        start(controller) {
          options.signal.addEventListener(
            "abort",
            () => controller.error(options.signal.reason),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
  `)}`;
  const client = startMcp({
    env: { PROVENTOOLS_API_URL: "https://www.proventools.net" },
    nodeArgs: ["--import", preload],
  });
  await client.send(toolCall(1, "get_credit_balance"));
  const response = await client.waitFor((message) => message.id === 1);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /timed out after 20 seconds/);
  await client.close();
});

test("MCP resumes parsing after stdout backpressure", async () => {
  const requests = Array.from({ length: 96 }, (_, index) =>
    `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/list" })}\n`
  ).join("");
  const child = spawn(process.execPath, ["packages/mcp/index.js"], {
    cwd: ROOT,
    env: childEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(requests);

  await new Promise((resolve) => setTimeout(resolve, 100));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 96);
  assert.deepEqual(new Set(responses.map(({ id }) => id)), new Set(Array.from({ length: 96 }, (_, index) => index + 1)));
});

test("MCP descriptions disclose optional OpenAI/provider processing and setup docs contain no literal key", async () => {
  const client = startMcp();
  await client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const response = await client.waitFor((message) => message.id === 1);
  const byName = new Map(response.result.tools.map((tool) => [tool.name, tool.description]));
  for (const name of [
    "recommend_ideas",
    "shortlist_ideas",
    "discover_ideas",
    "compare_ideas",
    "explain_idea_score",
  ]) {
    assert.match(byName.get(name), /OpenAI/);
    assert.match(byName.get(name), /Credit cost: 0/);
  }
  for (const name of ["request_evidence_refresh", "validate_my_idea"]) {
    assert.match(byName.get(name), /configured research or model providers/);
  }
  await client.close();

  const readmes = await Promise.all([
    readFile(path.join(ROOT, "packages/cli/README.md"), "utf8"),
    readFile(path.join(ROOT, "packages/mcp/README.md"), "utf8"),
  ]);
  for (const source of readmes) {
    assert.doesNotMatch(source, /pt_live_[a-z0-9]+/i);
    assert.doesNotMatch(source, /--env\s+PROVENTOOLS_API_KEY=/);
  }
});
