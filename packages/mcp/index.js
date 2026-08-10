#!/usr/bin/env node

const SERVER_VERSION = "0.1.0-beta.1";
const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_API_ORIGIN = "https://www.proventools.net";
const TRUSTED_API_ORIGINS = new Set([
  "https://www.proventools.net",
  "https://proventools.net",
]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024;
const MAX_SERVER_MESSAGE_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_INPUT_BYTES = 512 * 1024;
const MAX_CONCURRENT_TOOL_CALLS = 4;
const REQUEST_TIMEOUT_MS = 20_000;

const ZERO_CREDIT = "Credit cost: 0. Reads stored ProvenTools data only.";
const OPTIONAL_OPENAI =
  "Credit cost: 0. Depending on server configuration, ProvenTools may send any natural-language input and selected stored idea fields to OpenAI for semantic retrieval and bounded answer synthesis; otherwise it uses PostgreSQL retrieval and deterministic text.";
const intelligenceProperties = {
  query: { type: "string", description: "What you want to build or compare." },
  minimumScore: { type: "number", minimum: 0, maximum: 100 },
  maximumScore: { type: "number", minimum: 0, maximum: 100 },
  opportunityTypes: {
    type: "array",
    items: {
      type: "string",
      enum: ["web_saas", "ios_app", "developer_tool", "platform_app"],
    },
    maxItems: 4,
  },
  platforms: {
    type: "array",
    items: {
      type: "string",
      enum: [
        "ios", "ipad", "macos", "android", "web", "browser",
        "api", "cli", "vscode", "github", "shopify", "slack",
      ],
    },
    maxItems: 12,
  },
  confidence: {
    type: "array",
    items: { type: "string", enum: ["low", "medium", "high"] },
    maxItems: 3,
  },
  validationStates: {
    type: "array",
    items: {
      type: "string",
      enum: ["validated", "needs_validation", "needs_review", "legacy"],
    },
    maxItems: 4,
  },
  difficulties: {
    type: "array",
    items: { type: "string", enum: ["Easy", "Medium", "Hard"] },
    maxItems: 3,
  },
  maximumBudgetUsd: { type: "number", minimum: 0 },
  maximumBuildWeeks: { type: "number", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: 20 },
};

const tools = [
  {
    name: "search_ideas",
    description: `Search and filter the ProvenTools curated idea library. ${ZERO_CREDIT}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for." },
        category: { type: "string", description: "Exact category name." },
        difficulty: { type: "string", description: "Easy, Medium, or Hard." },
        page: { type: "integer", minimum: 1, description: "Results page." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_idea",
    description: `Get the full read-only breakdown for one curated idea. ${ZERO_CREDIT}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The idea id returned by search_ideas." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_build_prompt",
    description: `Get the agent-ready build prompt for one curated idea. ${ZERO_CREDIT}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The idea id returned by search_ideas." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "whats_new",
    description: `See the latest ProvenTools monthly idea drop. ${ZERO_CREDIT}`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_idea_evidence",
    description:
      `Get the latest stored evidence and ProvenScore history for one idea. This never starts live research. ${ZERO_CREDIT}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The idea id returned by search_ideas." },
        historyLimit: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "Maximum score snapshots to return (default 12).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_validation_report",
    description: `Get the current status or stored result for one of your validation jobs. ${ZERO_CREDIT}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A validation id from your ProvenTools account." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_credit_balance",
    description: `Get Live credit balances, expiry, usage, and activity. ${ZERO_CREDIT}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "recommend_ideas",
    description: `Recommend stored ideas using structured filters plus semantic retrieval. ${OPTIONAL_OPENAI}`,
    inputSchema: {
      type: "object",
      properties: intelligenceProperties,
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "shortlist_ideas",
    description: `Create a ranked shortlist from stored ideas. ${OPTIONAL_OPENAI}`,
    inputSchema: {
      type: "object",
      properties: intelligenceProperties,
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "discover_ideas",
    description: `Discover stored ideas from a natural-language brief. ${OPTIONAL_OPENAI}`,
    inputSchema: {
      type: "object",
      properties: intelligenceProperties,
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_ideas",
    description: `Compare two to ten stored ideas and their ProvenScores. ${OPTIONAL_OPENAI}`,
    inputSchema: {
      type: "object",
      properties: {
        ideaIds: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 10,
        },
        query: { type: "string" },
      },
      required: ["ideaIds"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_idea_score",
    description: `Explain one stored ProvenScore and its subscores. ${OPTIONAL_OPENAI}`,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

class ToolError extends Error {}

let stdoutBlocked = false;
let pendingOutputBytes = 0;
const pendingOutput = [];

function send(payload) {
  let serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERVER_MESSAGE_BYTES) {
    serialized = JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Response exceeded the MCP server safety limit." },
    });
  }

  const output = Buffer.from(`${serialized}\n`, "utf8");
  if (stdoutBlocked) {
    if (pendingOutputBytes + output.length > MAX_PENDING_OUTPUT_BYTES) {
      process.stdin.pause();
      process.stdin.destroy();
      return;
    }
    pendingOutput.push(output);
    pendingOutputBytes += output.length;
    return;
  }

  if (!process.stdout.write(output)) {
    stdoutBlocked = true;
    process.stdin.pause();
  }
}

function flushPendingOutput() {
  while (pendingOutput.length > 0) {
    const output = pendingOutput.shift();
    pendingOutputBytes -= output.length;
    if (!process.stdout.write(output)) return;
  }
  stdoutBlocked = false;
  resumeInputAfterOutputDrain();
}

process.stdout.on("drain", flushPendingOutput);

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function protocolError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolText(text, isError = false) {
  const value = String(text);
  if (Buffer.byteLength(value, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    throw new ToolError("The tool result exceeded the 128 KiB agent-output safety limit.");
  }
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
  };
}

function apiBaseUrl() {
  const configured = (process.env.PROVENTOOLS_API_URL || DEFAULT_API_ORIGIN).trim();
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new ToolError("PROVENTOOLS_API_URL must be a valid API origin.");
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new ToolError("PROVENTOOLS_API_URL must contain an origin only, without credentials, a path, query, or fragment.");
  }

  const trustedProduction = TRUSTED_API_ORIGINS.has(url.origin);
  const safeLoopback = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!trustedProduction && !safeLoopback) {
    throw new ToolError(
      "Refusing to send an API key to an untrusted origin. Use https://www.proventools.net, https://proventools.net, or HTTP on localhost, 127.0.0.1, or [::1] for local development."
    );
  }

  return url.origin;
}

function apiKey() {
  const key = (process.env.PROVENTOOLS_API_KEY || "").trim();
  if (!key) {
    throw new ToolError(
      "PROVENTOOLS_API_KEY is not set — get a key at www.proventools.net/dashboard/api-keys."
    );
  }
  return key;
}

async function readResponseText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ToolError("The ProvenTools API response exceeded the 2 MiB safety limit.");
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
      throw new ToolError("The ProvenTools API response exceeded the 2 MiB safety limit.");
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
    throw new ToolError("The ProvenTools API returned an invalid JSON response.");
  }
}

async function apiRequest(path, requestOptions = {}) {
  const options =
    typeof requestOptions === "string"
      ? { responseType: requestOptions }
      : requestOptions;
  const responseType = options.responseType || "json";
  const method = options.method || "GET";
  const baseUrl = apiBaseUrl();
  const headers = {
    Authorization: `Bearer ${apiKey()}`,
    Accept: responseType === "text" ? "text/markdown" : "application/json",
    "User-Agent": `proventools-mcp/${SERVER_VERSION}`,
    "X-ProvenTools-Channel": "mcp",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "error",
      signal: controller.signal,
    });
    const payload = await responsePayload(response, responseType);

    if (!response.ok) {
      const apiMessage = payload?.error?.message;
      const apiCode = payload?.error?.code;

      if (response.status === 401) {
        throw new ToolError(
          "Invalid API key — get one at www.proventools.net/dashboard/api-keys."
        );
      }
      if (response.status === 403) {
        throw new ToolError("API access requires the ProvenTools Live add-on.");
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        if (!retryAfter) {
          throw new ToolError(
            apiMessage
            || (apiCode === "MONTHLY_API_LIMIT_REACHED"
              ? "The monthly ProvenTools Live API request limit has been reached."
              : "A monthly ProvenTools Live allowance has been reached.")
          );
        }
        throw new ToolError(
          `ProvenTools rate limit reached — retry in ${retryAfter}s.`
        );
      }
      if (response.status === 503) {
        throw new ToolError("ProvenTools API keys are not provisioned yet. Try again later.");
      }
      throw new ToolError(apiMessage || `ProvenTools API request failed with status ${response.status}.`);
    }

    return payload;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (controller.signal.aborted) {
      throw new ToolError(`The ProvenTools API request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new ToolError(
      `Could not reach the ProvenTools API at ${baseUrl}. Check PROVENTOOLS_API_URL and your network connection.`
    );
  } finally {
    clearTimeout(timeout);
  }
}

function objectArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("Tool arguments must be an object.");
  }
  return value;
}

function optionalString(args, name) {
  if (args[name] === undefined) return undefined;
  if (typeof args[name] !== "string") throw new ToolError(`${name} must be a string.`);
  const value = args[name].trim();
  return value || undefined;
}

function requiredId(args) {
  const id = optionalString(args, "id");
  if (!id) throw new ToolError("id is required.");
  return id;
}

function intelligenceBody(action, args) {
  const filterNames = [
    "minimumScore",
    "maximumScore",
    "opportunityTypes",
    "platforms",
    "confidence",
    "validationStates",
    "difficulties",
    "maximumBudgetUsd",
    "maximumBuildWeeks",
  ];
  const filters = Object.fromEntries(
    filterNames
      .filter((name) => args[name] !== undefined)
      .map((name) => [name, args[name]])
  );
  return {
    action,
    ...(args.query ? { query: args.query } : {}),
    ...(args.ideaIds ? { ideaIds: args.ideaIds } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
  };
}

async function callTool(name, rawArguments) {
  const args = objectArguments(rawArguments || {});

  switch (name) {
    case "search_ideas": {
      const params = new URLSearchParams();
      const query = optionalString(args, "query");
      const category = optionalString(args, "category");
      const difficulty = optionalString(args, "difficulty");
      if (query) params.set("search", query);
      if (category) params.set("category", category);
      if (difficulty) params.set("difficulty", difficulty);
      if (args.page !== undefined) {
        if (!Number.isInteger(args.page) || args.page < 1) {
          throw new ToolError("page must be a positive integer.");
        }
        params.set("page", String(args.page));
      }
      const data = await apiRequest(`/ideas${params.size ? `?${params}` : ""}`);
      return toolText(JSON.stringify(data, null, 2));
    }
    case "get_idea": {
      const data = await apiRequest(`/ideas/${encodeURIComponent(requiredId(args))}`);
      return toolText(JSON.stringify(data, null, 2));
    }
    case "get_build_prompt": {
      const prompt = await apiRequest(
        `/ideas/${encodeURIComponent(requiredId(args))}/prompt`,
        "text"
      );
      return toolText(prompt);
    }
    case "whats_new": {
      const data = await apiRequest("/drops/latest");
      return toolText(JSON.stringify(data, null, 2));
    }
    case "get_idea_evidence": {
      const id = requiredId(args);
      const params = new URLSearchParams();
      if (args.historyLimit !== undefined) {
        if (
          !Number.isInteger(args.historyLimit)
          || args.historyLimit < 1
          || args.historyLimit > 60
        ) {
          throw new ToolError("historyLimit must be an integer between 1 and 60.");
        }
        params.set("history_limit", String(args.historyLimit));
      }
      const data = await apiRequest(
        `/ideas/${encodeURIComponent(id)}/evidence${params.size ? `?${params}` : ""}`
      );
      return toolText(JSON.stringify(data, null, 2));
    }
    case "get_validation_report": {
      const data = await apiRequest(
        `/validations/${encodeURIComponent(requiredId(args))}`
      );
      return toolText(JSON.stringify(data, null, 2));
    }
    case "get_credit_balance": {
      const data = await apiRequest("/credits");
      return toolText(JSON.stringify(data, null, 2));
    }
    case "recommend_ideas":
    case "shortlist_ideas":
    case "discover_ideas": {
      const action = name === "recommend_ideas"
        ? "recommend"
        : name === "shortlist_ideas"
          ? "shortlist"
          : "discover";
      const data = await apiRequest("/intelligence", {
        method: "POST",
        body: intelligenceBody(action, args),
      });
      return toolText(JSON.stringify(data, null, 2));
    }
    case "compare_ideas": {
      const data = await apiRequest("/intelligence", {
        method: "POST",
        body: intelligenceBody("compare", args),
      });
      return toolText(JSON.stringify(data, null, 2));
    }
    case "explain_idea_score": {
      const data = await apiRequest("/intelligence", {
        method: "POST",
        body: { action: "explain", ideaIds: [requiredId(args)] },
      });
      return toolText(JSON.stringify(data, null, 2));
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    protocolError(message?.id ?? null, -32600, "Invalid Request");
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (!hasId) return;

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "@proventools/mcp", version: SERVER_VERSION },
        instructions:
          "Every exposed tool costs 0 credits. Browse stored ProvenTools data and existing validation results. Intelligence tools disclose optional server-side OpenAI processing. This beta cannot spend credits or start paid jobs.",
      });
      return;
    case "tools/list":
      result(message.id, { tools });
      return;
    case "tools/call": {
      const name = message.params?.name;
      if (typeof name !== "string") {
        protocolError(message.id, -32602, "tools/call requires a tool name");
        return;
      }
      if (activeToolCalls >= MAX_CONCURRENT_TOOL_CALLS) {
        result(
          message.id,
          toolText(
            `Too many concurrent tool calls. ProvenTools MCP allows ${MAX_CONCURRENT_TOOL_CALLS} at a time.`,
            true
          )
        );
        return;
      }
      activeToolCalls += 1;
      try {
        result(message.id, await callTool(name, message.params?.arguments));
      } catch (error) {
        const text = error instanceof ToolError ? error.message : "The tool call failed unexpectedly.";
        result(message.id, toolText(text, true));
      } finally {
        activeToolCalls -= 1;
      }
      return;
    }
    case "ping":
      result(message.id, {});
      return;
    default:
      protocolError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

let activeToolCalls = 0;
let inputFragments = [];
let inputBufferBytes = 0;
let discardingOversizedMessage = false;
let bufferedInputBytes = 0;
let inputEnded = false;
const bufferedInput = [];

function processInputLine(lineBuffer) {
  const normalized = lineBuffer.at(-1) === 0x0d
    ? lineBuffer.subarray(0, -1)
    : lineBuffer;
  if (normalized.length === 0 || !normalized.toString("utf8").trim()) return;
  let message;
  try {
    message = JSON.parse(normalized.toString("utf8"));
  } catch {
    protocolError(null, -32700, "Parse error");
    return;
  }

  void handleMessage(message).catch(() => {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      protocolError(message.id, -32603, "Internal error");
    }
  });
}

function rejectOversizedMessage() {
  if (discardingOversizedMessage) return;
  discardingOversizedMessage = true;
  inputFragments = [];
  inputBufferBytes = 0;
  protocolError(
    null,
    -32600,
    `Request exceeded the ${MAX_CLIENT_MESSAGE_BYTES / 1024} KiB MCP message limit.`
  );
}

function bufferInput(chunk) {
  if (chunk.length === 0) return;
  if (bufferedInputBytes + chunk.length > MAX_BUFFERED_INPUT_BYTES) {
    protocolError(null, -32600, "Input backlog exceeded the MCP server safety limit.");
    bufferedInput.length = 0;
    bufferedInputBytes = 0;
    inputFragments = [];
    inputBufferBytes = 0;
    process.stdin.destroy();
    return;
  }
  bufferedInput.push(Buffer.from(chunk));
  bufferedInputBytes += chunk.length;
}

function processInputChunk(chunk) {
  let offset = 0;

  while (offset < chunk.length) {
    const newline = chunk.indexOf(0x0a, offset);
    const end = newline === -1 ? chunk.length : newline;
    const segment = chunk.subarray(offset, end);

    if (!discardingOversizedMessage) {
      if (inputBufferBytes + segment.length > MAX_CLIENT_MESSAGE_BYTES) {
        rejectOversizedMessage();
      } else if (segment.length > 0) {
        inputFragments.push(Buffer.from(segment));
        inputBufferBytes += segment.length;
      }
    }

    if (newline === -1) return;
    if (discardingOversizedMessage) {
      discardingOversizedMessage = false;
    } else {
      processInputLine(Buffer.concat(inputFragments, inputBufferBytes));
    }
    inputFragments = [];
    inputBufferBytes = 0;
    offset = newline + 1;

    if (stdoutBlocked && offset < chunk.length) {
      bufferInput(chunk.subarray(offset));
      return;
    }
  }
}

function finishInput() {
  if (!discardingOversizedMessage && inputBufferBytes > 0) {
    processInputLine(Buffer.concat(inputFragments, inputBufferBytes));
  }
  inputFragments = [];
  inputBufferBytes = 0;
}

function resumeInputAfterOutputDrain() {
  while (!stdoutBlocked && bufferedInput.length > 0) {
    const chunk = bufferedInput.shift();
    bufferedInputBytes -= chunk.length;
    processInputChunk(chunk);
  }
  if (stdoutBlocked) return;
  if (inputEnded) {
    finishInput();
  } else {
    process.stdin.resume();
  }
}

process.stdin.on("data", (value) => {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (stdoutBlocked) {
    bufferInput(chunk);
    return;
  }
  processInputChunk(chunk);
});

process.stdin.on("end", () => {
  inputEnded = true;
  if (!stdoutBlocked && bufferedInput.length === 0) finishInput();
});
