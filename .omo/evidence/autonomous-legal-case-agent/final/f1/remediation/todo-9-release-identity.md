# Todo 9 delivered release identity

Freshly checked without rebuilding:

- Commit approved: `6bb3c5d6f72adf16ca3f55e1a31746502ac8b00d`
- Installer: `apps/desktop/dist/small-fraud-agent-0.1.0-x64-setup.exe`
- SHA-256: `27504ab539e3b2d160c76369b37f824f93f22baf9b73bc50e9b9a744b4e630d6`
- Size: 281,300,107 bytes
- Identity: regular, non-symlink, one link, mode `0600`, `opc:opc` (`1000:1000`)
- Independent verdict: `.omo/evidence/autonomous-legal-case-agent/task-9/final-independent-approval/verdict.json` (SHA-256 `507e11e28b1d5677128928efa5b3fc5bc9a6c2018e3a695392e20e197b550865`)
- Installer identity receipt SHA-256: `9003d5660c1cc776ed49332038e129eee967be2b189ecd84455b7d08f3713445`

All four production Electron routes passed: `agent-happy`, `agent-approval`, `agent-resume`, and `agent-provider-failure`. The independent verdict records NSIS/payload/ASAR extractAll success, 19 package tests, 317 full tests, live privacy/law/provider QA, static lint/typecheck/build/LSP gates, Windows x64 closure, and zero forbidden payload matches.

The earlier remediation artifact `99a47ea419ec308abdc89f516982b4f5fe99f3bd67c339ddaa0e058b521b0cc0` had the same byte count but was replaced when the independent verifier ran a fresh `dist:win`. It is superseded and is not the delivered artifact. The current checksum receipt and current installer both identify only `27504ab...`.
