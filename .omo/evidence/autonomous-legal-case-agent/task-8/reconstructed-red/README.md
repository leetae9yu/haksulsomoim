# Todo 8 reconstructed RED -> GREEN

## Revisions

- Pre-fix revision: `c80572fabb9b2f3e3a53cfd6c5bcbc76369116e1`
- Todo 8 fix: `21053b375758982a9a54e883b1c57528ff77df3b`
- Current GREEN revision: `6bb3c5d6f72adf16ca3f55e1a31746502ac8b00d`
- Independent Todo 8 verdict: unconditional PASS, recorded in `.omo/start-work/ledger.jsonl` and task `st_019ffb8f`

The Todo 8 tests did not exist as a complete test set at the parent. Exact test blobs from the fix commit were therefore copied, unchanged, into isolated detached worktrees. `harness-sha256.txt` binds every copied file to its source blob content. No harness changes were committed and no assertion was weakened.

## Exact command and results

The same eight test files were run at the pre-fix and current revisions. Full commands, overlay status, output, assertion diffs, and exit codes are in `red.txt` and `green.txt`.

- RED at `c80572f`: 27 pass, 13 fail, exit 1.
- GREEN at current HEAD: 40 pass, 0 fail, exit 0.

The RED failures are causal and target Todo 8 changes:

- raw email survived unstructured OCR redaction;
- outbound Agent projection retained a raw email from adversarial confirmed OCR;
- the provider attempted outbound thread creation instead of rejecting seven raw identifier classes;
- the provider output schema used unsupported `oneOf` forms;
- malicious citation metadata, path-like timestamps, and embedded foreign URLs were accepted;
- MCP failures exposed provider IDs, private paths, and URLs;
- rejected arbitrary MCP tool names and attacker arguments were reflected into the receipt.

The prompt-injection instruction remains visible after identifiers are masked by design: host policy and the closed tool registry, not prose deletion, prevent execution. The unapproved-tool tests prove zero adapter calls.

Provider timeout/late completion/disposal, host cancellation after persistence, unavailable-provider manual recovery, unavailable-law recovery, stale context, budgets, duplicate results, and consequential-action denial were already GREEN at the pre-fix revision and remain GREEN at current HEAD. They are included to prove Todo 8 did not regress those prerequisite controls; they are not misreported as reconstructed failures.

## Isolation and cleanup

Both runs used detached temporary worktrees and a temporary `node_modules` symlink to the shared immutable dependency installation. `worktree-cleanup.txt` records removal. The shared worktree was never checked out or reset, and no temporary worktree, link, process, or test patch remains.
