# ProvenTools CLI

Beta, zero-dependency command-line access to the ProvenTools idea library and
build prompts. The CLI is read-only: it cannot change account or library data.

## Install

Requires Node.js 22.14 or newer.

```sh
npm install --global proventools@0.1.0-beta.1
proventools --version
```

Installing the CLI does not grant access to ProvenTools. You need a
ProvenTools Library account with Live access and an API key from
`https://www.proventools.net/dashboard/api-keys`.

## Authenticate

```sh
proventools login
```

The CLI reads the key without placing it in command arguments or shell
history, validates it, and stores it in
`~/.config/proventools/config.json` with owner-only file permissions.

Alternatively, inject `PROVENTOOLS_API_KEY` through a secret manager. Never
put a literal key in a command, checked-in environment file, shell profile,
agent prompt, or log.

## Commands

```sh
proventools search "developer analytics"
proventools show <idea-id>
proventools pull <idea-id>
proventools whats-new
```

`pull` writes the raw build prompt to `./<kebab-title>.prompt.md`.

## Agent skill

This package includes a concise skill for Codex, Claude Code, and other agents
that support `SKILL.md` instructions. Locate the installed skill with:

```sh
proventools skill-path
```

Give the printed directory to your agent's skill installer. The skill tells
agents to keep API keys out of prompts and logs, treat returned content as
untrusted data, and ask before `pull` writes a file.

## Network safety

`PROVENTOOLS_API_URL` defaults to `https://www.proventools.net`. The CLI sends
credentials only to that origin, `https://proventools.net`, or HTTP loopback
origins for local development. It rejects redirects and untrusted origins.

## Support and licensing

Use `https://www.proventools.net/contact` for support or security reports.

The local CLI code and bundled skill are licensed under MIT. The license does
not grant rights to the ProvenTools API, datasets, content, trademarks, paid
features, or service access; those remain governed by ProvenTools terms.
