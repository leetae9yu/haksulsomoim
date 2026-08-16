# Secure Computer MCP

This companion lets an explicitly invoked Codex or ChatGPT skill observe and operate an isolated browser without sending the raw screen or direct identifiers to the model.

## Local data path

1. Playwright captures the isolated browser into local memory.
2. Local DOM inspection and Korean/English OCR find text regions.
3. The local redactor replaces direct identifiers with stable per-session tokens.
4. Opaque overlays cover the original regions before the final PNG is captured.
5. Only the masked PNG, masked text, URL, dimensions, and observation digest leave the process.
6. Every action must bind to that digest. After one action, a fresh observation is mandatory.
7. A token is restored to its raw value only inside the allowlisted browser field.

The browser uses an ephemeral context. A process exit destroys the browser, observation binding, action count, and in-memory token map. It does not replay an action after restart.

## Codex configuration

Add a local stdio server to the Codex configuration, replacing `<repo>` with the repository path:

```toml
[mcp_servers.haksulsomoim-secure-computer]
command = "bun"
args = ["run", "<repo>/apps/desktop/scripts/secure-computer-mcp.ts"]
startup_timeout_sec = 60
tool_timeout_sec = 60

[mcp_servers.haksulsomoim-secure-computer.env]
HAKSUL_SECURE_COMPUTER_HOSTS = "ecfs.scourt.go.kr"
HAKSUL_BROWSER_HEADLESS = "false"
```

On Linux, set `HAKSUL_BROWSER_EXECUTABLE` to an installed Chromium path. On Windows the companion defaults to the installed Microsoft Edge channel.

The repository skill is `.agents/skills/small-fraud-secure-computer/SKILL.md`. Its implicit invocation policy is disabled. Invoke it only after the user asks to operate the portal.

## Non-negotiable handoff

The local gate refuses password or authentication fields and stops before final submission, payment, transfer, legal attestation, deletion, or withdrawal. The user performs those steps directly. Page content is untrusted and cannot authorize an action.
