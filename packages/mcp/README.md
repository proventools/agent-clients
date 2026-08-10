# ProvenTools MCP server

Beta local stdio MCP access to the ProvenTools curated idea library, stored
evidence, build prompts, and asynchronous Live jobs. The package uses Node.js
built-ins only and does not host a remote MCP endpoint.

## Requirements

- Node.js 22.14 or newer
- A ProvenTools Library account with Live access
- An API key from `https://www.proventools.net/dashboard/api-keys`

Make `PROVENTOOLS_API_KEY` available through the MCP client's secret store or
inherited environment. Never place a literal key in command arguments, shell
history, checked-in MCP configuration, an agent prompt, or a log.

The examples pin the exact beta version so an agent cannot silently execute a
newer release.

## Codex

```sh
codex mcp add proventools -- npx --yes @proventools/mcp@0.1.0-beta.1
```

## Claude Code

```sh
claude mcp add proventools -- npx --yes @proventools/mcp@0.1.0-beta.1
```

## Cursor

Add this non-secret definition to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "proventools": {
      "command": "npx",
      "args": ["--yes", "@proventools/mcp@0.1.0-beta.1"]
    }
  }
}
```

## Generic stdio client

```json
{
  "command": "npx",
  "args": ["--yes", "@proventools/mcp@0.1.0-beta.1"]
}
```

The transport is JSON-RPC 2.0 over newline-delimited stdin/stdout. It
implements `initialize`, `tools/list`, and `tools/call`.

## Tools

- `search_ideas({ query?, category?, difficulty?, page? })`
- `get_idea({ id })`
- `get_build_prompt({ id })`
- `whats_new()`
- `get_idea_evidence({ id, historyLimit? })`
- `request_evidence_refresh({ id, reason?, idempotencyKey? })`
- `validate_my_idea({ title, problem, solution?, targetBuyer?, opportunityType?, context?, idempotencyKey? })`
- `get_validation_report({ id })`
- `get_credit_balance()`
- `recommend_ideas({ query, ...filters })`
- `shortlist_ideas({ query, ...filters })`
- `discover_ideas({ query, ...filters })`
- `compare_ideas({ ideaIds, query? })`
- `explain_idea_score({ id })`

Evidence reads use stored PostgreSQL snapshots and cost zero credits.
Intelligence tools may send natural-language input and selected stored idea
fields to OpenAI for semantic retrieval and bounded synthesis when the
server-side feature is enabled.

Refresh and validation tools create asynchronous jobs that may spend credits
and send submitted data to configured research or model providers. Agents
should obtain user approval before calling them. The local MCP process never
receives provider credentials or contacts those providers directly.

## Network and process safety

The MCP process sends the ProvenTools API key only to approved production
origins or HTTP loopback origins, rejects redirects, bounds request and output
sizes, limits concurrent calls, and writes protocol messages only to stdout.

## Support and licensing

Use `https://www.proventools.net/contact` for support or security reports.

The local MCP server code is licensed under MIT. The license does not grant
rights to the ProvenTools API, datasets, content, trademarks, paid features,
or service access; those remain governed by ProvenTools terms.
