# ProvenTools agent clients

Official open-source clients for connecting developer tools and local agents
to ProvenTools.

- `proventools`: read-only CLI plus a bundled agent skill
- `@proventools/mcp`: read-only local stdio MCP server

The hosted ProvenTools application, API implementation, datasets, content,
and customer systems are not part of this repository.

## Status

The CLI and read-only local MCP betas are published on npm and GitHub.

The repository also contains metadata prepared for the official MCP Registry,
Claude's community plugin marketplace, and the Cursor Directory. Installing
the clients is free. Access to ProvenTools data still requires an eligible
ProvenTools account and API key.

Directory publication is approval-gated and is not performed by the test or
npm staging workflows.

## Verify

Use Node.js 22.14 or newer:

```sh
npm test
```

The tests build the real npm tarballs, enforce exact contents, scan for common
credential and personal-data patterns, install both packages offline, and run
their executable smoke tests.

## Security

Never include a ProvenTools API key in an issue, prompt, command argument,
checked-in configuration, or log. Report vulnerabilities privately through
`https://www.proventools.net/contact`.

## License

The client code, tests, documentation, and bundled skill in this repository
are licensed under MIT. The license does not grant rights to the ProvenTools
API, datasets, content, trademarks, paid features, or service access.
