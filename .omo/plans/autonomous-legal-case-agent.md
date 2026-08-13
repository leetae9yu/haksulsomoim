# autonomous-legal-case-agent - Work Plan

## TL;DR (For humans)
**What you'll get:** 지금의 수동 워크플로와 일회성 조언 기능을, 사건 목표를 받아 공식 근거를 조사하고 증거 누락을 분석하며 문서 초안을 만드는 지속형 AI Agent로 교체합니다. Agent는 수행한 판단과 도구 결과를 암호화해 남기고, 중단·재시작 후에도 안전하게 이어집니다.

**Why this approach:** 모델이 컴퓨터를 임의로 조작하게 하지 않고, 앱이 허용한 도구만 실행하는 구조로 만듭니다. 안전한 로컬 분석과 공식 법령 조회는 자동화하되 법적 확인·제출·결제 같은 결과가 큰 행동은 항상 사용자에게 돌려줍니다.

**What it will NOT do:** 사이트 로그인, 본인인증, 법적 선언, 제출, 결제, 임의 브라우저·파일·명령 실행을 자동화하지 않습니다. 원본 증거나 직접 식별정보를 외부 모델에 보내지 않으며, 기존 수동 처리 방식도 없애지 않습니다.

**Effort:** XL
**Risk:** High - 지속 상태, 모델 프로토콜, 암호화 저장, 승인 경계, Electron UI와 Windows 패키징을 함께 변경합니다.
**Decisions I made for you:** 한 사건당 실행은 하나만 허용하고, 모델 판단 12회·도구 실행 8회·5분 한도를 둡니다. 실행 시작 시 정확한 마스킹 문맥을 한 번 승인하고, 문맥이 바뀌면 다시 승인받습니다. 충돌 가능성이 있는 실행은 재시작 때 자동 반복하지 않고 사용자가 재개하도록 합니다. 이 값과 정책은 추후 되돌릴 수 있습니다.

Your next move: `/start-work`로 이 계획을 실행합니다. Full execution detail follows below.

---

> TL;DR (machine): XL/high-risk replacement of one-shot suggestions with a durable host-controlled bounded Agent loop, secure tool policy, encrypted recovery, Agent workspace, adversarial QA, and Windows release.

## Scope
### Must have
- A real, observable Agent loop: `decide -> validate -> execute tool -> persist observation -> decide again`, continuing until a typed terminal state or a user boundary.
- A host-owned, closed TypeScript contract for agent goals, runs, steps, model decisions, tool calls/results, approval requests/decisions, budgets, and terminal reasons.
- Encrypted local persistence of the run snapshot and ordered immutable step history, including crash-safe before/after-tool checkpoints.
- A Codex adapter that requests exactly one structured next decision per turn and supports documented `turn/interrupt`, without granting Codex arbitrary shell, filesystem, IPC, MCP, or network access.
- An allowlisted host tool registry for: reading the masked case/workflow snapshot; searching official Korean law; retrieving cited law text; analyzing evidence gaps; producing/updating encrypted local draft artifacts; requesting bounded user input; proposing a user action; and finishing.
- Automatic execution only for reversible local/read-only tools. Login, identity verification, OCR fact confirmation, legal attestations/declarations, portal navigation, filing/submission, payment, external opening, and workflow mutations remain explicit user actions.
- Digest-bound outbound consent: starting a run approves one exact masked context digest; material context changes pause the run and require renewed consent.
- Host-enforced limits of 12 model decisions, 8 tool executions, 5 minutes, and one active run per case. Hitting any limit produces a typed paused/failed terminal outcome without corrupting the case.
- Restart-safe recovery: an ambiguous in-flight step becomes `interrupted`; it is never silently replayed. Resume is explicit and idempotency keys prevent duplicate committed results.
- A renderer Agent workspace showing goal, run state, current step, executed tools, official citations, pending approval/input, remaining budgets, pause/cancel/resume controls, and encrypted draft artifacts.
- Existing local OCR confirmation, direct-identifier redaction, citation provenance, civil/criminal separation, manual fallback, Electron security, and Windows x64 packaging behavior preserved.
- TDD for every behavioral increment and real Electron QA proving at least two observation-driven autonomous tool choices, approval gating, cancellation/resume, provider failure, privacy, and manual-workflow regression.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No autonomous login, identity verification, OCR confirmation, legal attestation/declaration, portal/browser control, filing/submission, payment, or external side effect.
- No arbitrary model-selected tool name, shell command, filesystem path, URL, IPC channel, MCP tool, or provider permission.
- No raw evidence bytes, original OCR text, direct identifiers, secrets, filenames containing identifiers, or unapproved citation content sent outbound.
- No model-authored direct mutation of `RuntimeCaseDossier`, `CaseWorkflow`, or persisted agent state; only host reducers/services may commit typed transitions.
- No reliance on Codex threads as the persistence authority, on exactly-once provider execution, on undocumented protocol behavior, or on interrupt killing descendant processes.
- No cloud database, multi-user collaboration, mobile client, new case type, or scope expansion beyond domestic bank-transfer fraud claims up to KRW 30,000,000.
- No replacement or degradation of the existing manual workflow when Codex or Korean-law MCP is signed out, unavailable, malformed, timed out, or cancelled.
- No prose-pinning tests, fixed sleeps, polling delays, broad mocks, disabled/skipped tests, type/lint suppression, `any`, non-null assertions, or files above the project’s 250 pure-LOC ceiling.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD with `bun test`; every behavior todo captures a focused RED before production edits and the corresponding GREEN afterward.
- Unit/integration gates: `bun test <named test files>` for each todo, then `bun test`, `bun run lint`, `bun run typecheck`, and `bun run build` once after all implementation inputs settle.
- Real desktop gate: extend `bun run qa:desktop` with deterministic `agent-happy`, `agent-approval`, `agent-resume`, and `agent-provider-failure` scenarios driven through the real Electron/Playwright surface. Each scenario writes an action log, JSON receipt, and screenshot.
- Privacy gate: extend `bun run qa:privacy -- --evidence-dir <attemptDir>/privacy` so agent decisions, observations, errors, drafts, filenames, and logs report every identifier class masked and zero raw-value matches.
- Live integration gates: `bun run qa:korean-law-mcp -- --evidence-dir <attemptDir>/law` and `bun run qa:agent-provider -- --evidence-dir <attemptDir>/provider`; a missing credential/sign-in is a typed recoverable result, while authenticated runs must prove one cited law result and one structured next-decision result.
- Packaging gate: `bun run dist:win`; inspect the generated report and ASAR/unpacked payload to prove no QA fixtures/evidence/secrets are shipped and all required Codex/MCP runtime dependencies remain present.
- Evidence root: `<attemptDir>/task-<N>-autonomous-legal-case-agent.*`, where `attemptDir` is the current `omo-agent-toolkit ulw-loop status --json` attempt directory; outside ulw-loop use `.omo/evidence/autonomous-legal-case-agent/`.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1 — contract foundation: Todo 1.
- Wave 2 — independent persistence/provider lanes: Todos 2 and 3 run in parallel after Todo 1 because they edit disjoint modules and meet only at the orchestration contract.
- Wave 3 — central orchestration: Todo 4 integrates contracts, repository, provider, tools, budgets, and policy; keep this single-owner because parallel edits would collide on the state machine.
- Wave 4 — independent boundary wiring: Todos 5 and 6 run in parallel after Todo 4; IPC/preload and runtime composition have disjoint primary write scopes.
- Wave 5 — user surface and adversarial proof: Todos 7 and 8 run in parallel after their respective boundaries settle; coordinate fixtures but do not edit the same test/QA files.
- Wave 6 — integrated Electron/release work: Todo 9 owns shared QA entrypoints, real-surface scenarios, packaging, and final installer generation.
- Final wave — F1-F4 launch simultaneously only after Todo 9 and every prior acceptance command are green. A single failure returns work to the owning todo; reviewers do not patch code themselves.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 2, 3, 4, 5, 6, 7 | none |
| 2 | 1 | 4, 6, 8 | 3 |
| 3 | 1 | 4, 8 | 2 |
| 4 | 1, 2, 3 | 5, 6, 7, 8 | none |
| 5 | 4 | 7, 8 | 6 |
| 6 | 2, 4 | 7, 8, 9 | 5 |
| 7 | 4, 5, 6 | 8, 9 | 8, with disjoint fixture ownership |
| 8 | 2, 3, 4, 5, 6 | 9 | 7, with disjoint fixture ownership |
| 9 | 6, 7, 8 | F1-F4 | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Define the closed Agent domain and boundary contracts
  What to do / Must NOT do: Add strict discriminated unions and Zod IPC schemas for `AgentGoal`, `AgentRun`, `AgentStep`, `AgentDecision`, allowlisted `AgentToolCall`/`AgentToolResult`, `ApprovalRequest`/`ApprovalDecision`, budgets, interruption, and terminal outcomes. Use branded IDs and exhaustive switches. Model one active run per case and separate civil/criminal objectives. Do not put prompt prose or provider-specific payloads in domain contracts.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 2, 3, 4, 5, 6, 7
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/contracts/desktop-api.ts:1-171`; `apps/desktop/src/contracts/desktop-api.test.ts:9-76`; `apps/desktop/src/integrations/agent-provider/suggestion-contracts.ts:1-88`; `apps/desktop/src/main/runtime-case-types.ts:1-25`; `/home/opc/.local/lib/node_modules/omo-ai/plugin/skills/programming/references/typescript/README.md`.
  Acceptance criteria (agent-executable): RED then GREEN with `bun test src/contracts/desktop-api.test.ts src/main/agent/agent-contracts.test.ts`; tests prove unknown tool names, stale approval IDs/digests, negative/exhausted budgets, malformed steps, and civil/criminal objective conflation are rejected while a valid run round-trips. Run `bun run typecheck`.
  QA scenarios (name the exact tool + invocation): happy — `bun test src/main/agent/agent-contracts.test.ts --test-name-pattern "round-trips a valid bounded run"` exits 0; failure — `bun test src/main/agent/agent-contracts.test.ts --test-name-pattern "rejects unknown tools and stale approval digests"` exits 0 after asserting parse failure. Evidence `<attemptDir>/task-1-agent-contracts.txt`.
  Commit: Y | `Add bounded agent domain contracts`
  Recommended task executor category: `unspecified-high` — strict cross-boundary contracts affect domain, IPC, and later persistence.

- [x] 2. Persist encrypted Agent runs with crash-safe checkpoints
  What to do / Must NOT do: Implement an `AgentRunRepository` under `src/main/agent/` using the existing AES-256-GCM, HMAC locator, atomic temporary-write/rename, mode `0600`, and cleanup patterns. Persist a run snapshot containing an ordered immutable step history. Save `decision-started` before provider work and `tool-started` before execution; save the corresponding result before advancing the cursor. On load, convert ambiguous in-flight work to typed `interrupted`. Enforce run and step idempotency keys. Do not store raw evidence, direct identifiers, secrets, or unredacted model/provider errors.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 4, 6, 8
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/main/runtime-case-repository.ts:1-187`; `apps/desktop/src/main/runtime-case-repository.test.ts:44-106`; `apps/desktop/src/storage/local-case-store.ts`; `apps/desktop/src/main/master-key.ts`; `apps/desktop/src/security/redaction.ts`; Todo 1 contracts.
  Acceptance criteria (agent-executable): RED then GREEN with `bun test src/main/agent/agent-run-repository.test.ts`; prove encrypted round-trip, no plaintext facts/decisions/errors on disk, atomic single-record publication, duplicate run rejection, duplicate completed tool result idempotency, temporary-file cleanup, malformed/corrupt record rejection, and restart conversion of an in-flight step to `interrupted`.
  QA scenarios (name the exact tool + invocation): happy — `bun test src/main/agent/agent-run-repository.test.ts --test-name-pattern "resumes from the last committed observation without duplicate execution"` exits 0; failure — the same file’s `"rejects plaintext, corrupt records, and duplicate publication"` cases exit 0. Evidence `<attemptDir>/task-2-agent-repository.txt`.
  Commit: Y | `Persist encrypted autonomous agent runs`
  Recommended task executor category: `deep` — encryption, atomic publication, idempotency, and crash recovery are coupled correctness boundaries.

- [x] 3. Upgrade Codex from one-shot suggestions to typed next decisions
  What to do / Must NOT do: Extend the Codex protocol and provider contract to request one `AgentDecision` per turn using `outputSchema`, capture `threadId`/`turnId`, consume completion notifications, and expose bounded `interrupt`. Prefer a fresh ephemeral turn context built from the host’s masked run projection; do not make Codex history the persistence authority. Validate every decision locally and sanitize all provider errors. Retain login/manual fallback and the existing suggestion API only until renderer migration is complete, then remove the unused suggestion surface rather than shipping two competing Agent concepts.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 4, 8
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/integrations/agent-provider/agent-provider.ts:1-208`; `apps/desktop/src/integrations/agent-provider/agent-provider.test.ts:91-230`; `apps/desktop/src/integrations/agent-provider/codex-app-server-protocol.ts:1-38`; `apps/desktop/src/integrations/agent-provider/codex-app-server-connection.ts:30-152`; official Codex app-server README at commit `902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe`; Todo 1 contracts.
  Acceptance criteria (agent-executable): RED then GREEN with `bun test src/integrations/agent-provider/agent-provider.test.ts`; prove only masked/approved context and the closed schema are sent, valid decisions parse, unknown tools/extra keys/unapproved citations/duplicate IDs fail, non-completed turns fail, a 30-second injected clock deadline interrupts, `turn/interrupt` targets the active IDs, late notifications cannot complete a replacement turn, and disposal rejects active work without leaking secrets.
  QA scenarios (name the exact tool + invocation): happy — `bun test src/integrations/agent-provider/agent-provider.test.ts --test-name-pattern "returns one typed next decision from approved masked context"` exits 0; failure — `bun test ... --test-name-pattern "interrupts a timed-out turn and ignores late completion"` exits 0 with an event-driven fake and no fixed sleep. Evidence `<attemptDir>/task-3-codex-decisions.txt`.
  Commit: Y | `Add structured Codex agent decisions`
  Recommended task executor category: `deep` — bidirectional protocol notifications, cancellation, and race handling require focused reasoning.

- [x] 4. Implement the host-owned bounded Agent loop and tool policy
  What to do / Must NOT do: Add `AgentLoopService`, a pure reducer, and a closed tool registry. For each run: read the persisted projection, enforce consent digest and budgets, ask the provider for one decision, validate it, execute exactly one allowed tool, redact and persist the observation, then continue. Tools may inspect the masked case, call allowlisted official-law search/detail adapters, compute evidence gaps, write encrypted local draft artifacts, request user input/action, or finish. Route all case mutations through existing domain services and leave them pending for user action; never execute attestations, workflow commands, external opens, login, submission, or payment. Serialize by case with `RuntimeCaseMutationQueue`.
  Parallelization: Wave 3 | Blocked by: 1, 2, 3 | Blocks: 5, 6, 7, 8
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/main/runtime-case-service.ts:38-256`; `apps/desktop/src/main/runtime-case-mutation-queue.ts:1-25`; `apps/desktop/src/main/legal-guidance.ts:1-70`; `apps/desktop/src/integrations/korean-law-mcp/korean-law-mcp.ts`; `apps/desktop/src/domain/case-workflow.ts`; Todos 1-3.
  Acceptance criteria (agent-executable): RED then GREEN with `bun test src/main/agent/agent-loop-service.test.ts`; prove an observation changes the next provider input and causes at least two distinct automatic safe tool choices before finish; one active run per case; 12-decision/8-tool/5-minute budgets; deny/stale approval pauses; changed context digest pauses; unknown or unsafe tool fails closed; duplicate result is not re-executed; provider/MCP unavailable pauses while manual case APIs remain usable; cancellation interrupts an active turn and commits a terminal/pause record.
  QA scenarios (name the exact tool + invocation): happy — `bun test src/main/agent/agent-loop-service.test.ts --test-name-pattern "uses a persisted observation to choose and execute the next safe tool"` exits 0 and asserts the second provider input contains the first observation digest; failure — `bun test ... --test-name-pattern "never executes consequential or stale-approved actions"` exits 0 and records zero tool side effects. Evidence `<attemptDir>/task-4-agent-loop.txt`.
  Commit: Y | `Implement bounded autonomous case loop`
  Recommended task executor category: `ultrabrain` — this is the central state-machine, policy, concurrency, and termination algorithm.

- [x] 5. Expose Agent lifecycle through secure typed IPC
  What to do / Must NOT do: Add start/status/approve/deny/provide-input/pause/cancel/resume IPC contracts, channels, handlers, trusted sender registration, and preload methods. Bind every mutation to case ID, run ID, step/approval ID, and digest. Return bounded projections only; never expose raw persisted events, raw provider payloads, filesystem paths, secrets, or writable service objects. Preserve every existing official-source/authentication origin restriction.
  Parallelization: Wave 4 | Blocked by: 4 | Blocks: 7, 8
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/contracts/desktop-api.ts:1-171`; `apps/desktop/src/contracts/ipc-channels.ts:1-15`; `apps/desktop/src/main/ipc-handlers.ts:1-102`; `apps/desktop/src/main/ipc-handlers.test.ts:46-126`; `apps/desktop/src/main/ipc-register.ts:17-46`; `apps/desktop/src/preload/index.ts:1-42`; `apps/desktop/src/main/security.ts`; Todo 4 service API.
  Acceptance criteria (agent-executable): RED then GREEN with `bun test src/contracts/desktop-api.test.ts src/main/ipc-handlers.test.ts src/main/ipc-register.test.ts src/preload/index.test.ts`; prove valid lifecycle routing and reject unknown fields, missing/mismatched IDs, stale approvals, renderer-supplied tool results/masked context, duplicate handlers, untrusted senders, and oversized user input.
  QA scenarios (name the exact tool + invocation): happy — `bun test src/main/ipc-handlers.test.ts --test-name-pattern "routes the complete agent lifecycle through typed case-bound requests"` exits 0; failure — `bun test ... --test-name-pattern "rejects stale approvals and renderer-supplied tool execution"` exits 0. Evidence `<attemptDir>/task-5-agent-ipc.txt`.
  Commit: Y | `Expose secure agent lifecycle IPC`
  Recommended task executor category: `unspecified-high` — coordinated contract, main-process, preload, and security-boundary work.

- [x] 6. Wire Agent services into runtime lifecycle and recovery
  What to do / Must NOT do: Compose the repository, tool registry, provider, law adapter, Agent loop, and IPC handlers in `createDesktopRuntime`. Lazily initialize external integrations, resume only explicitly requested interrupted runs, and dispose active turns, MCP, OCR, and provider deterministically with aggregate failure reporting. Keep the manual case runtime available when Agent dependencies fail. Do not start background runs at app boot without the user opening/resuming a case.
  Parallelization: Wave 4 | Blocked by: 2, 4 | Blocks: 7, 8, 9
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/main/runtime.ts:20-92`; `apps/desktop/src/main/runtime.test.ts`; `apps/desktop/src/main/lifecycle.ts`; `apps/desktop/src/main/runtime-case-service.ts`; `apps/desktop/src/main/runtime-case-repository.ts`; Todos 2 and 4.
  Acceptance criteria (agent-executable): RED then GREEN with `bun test src/main/runtime.test.ts src/main/agent/agent-runtime.integration.test.ts`; prove an interrupted encrypted run is discoverable after a full runtime restart, requires explicit resume, continues without duplicate tool execution, cancellation/disposal settles every initialized dependency, and provider initialization failure leaves create/evidence/manual workflow functional.
  QA scenarios (name the exact tool + invocation): happy — `bun test src/main/agent/agent-runtime.integration.test.ts --test-name-pattern "resumes an interrupted run after recreating the desktop runtime"` exits 0; failure — `bun test src/main/runtime.test.ts --test-name-pattern "keeps manual workflows available when agent initialization fails"` exits 0. Evidence `<attemptDir>/task-6-agent-runtime.txt`.
  Commit: Y | `Wire restart-safe agent runtime`
  Recommended task executor category: `deep` — runtime lifecycle, restart recovery, and aggregate cleanup span multiple integration boundaries.

- [x] 7. Replace the optional suggestion panel with an Agent workspace
  What to do / Must NOT do: Build an accessible Korean Agent workspace that lets the user define/start the case goal, approve the outbound masked-context digest, watch a live ordered timeline, inspect cited observations and remaining budgets, answer bounded questions, approve/deny pending consequential actions, pause/cancel/resume, and open encrypted draft artifacts through safe app-owned controls. Keep civil/criminal tracks visibly separate and preserve the existing case/evidence/manual workflow. Remove “OPTIONAL CODEX / 문안 점검 제안” once the Agent workspace fully replaces it. Avoid a generic chat UI; the primary surface is goal/state/tools/evidence/actions.
  Parallelization: Wave 5 | Blocked by: 4, 5, 6 | Blocks: 8, 9
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/renderer/src/App.tsx:21-177`; `apps/desktop/src/renderer/src/TrackBoard.tsx:21-99`; `apps/desktop/src/renderer/src/components/CodexPanel.tsx:30-205`; `apps/desktop/src/renderer/src/components/GuidancePanel.tsx:14-91`; `apps/desktop/src/renderer/src/App.integrations.test.tsx:17-142`; `apps/desktop/src/renderer/src/App.resilience.test.tsx:22-239`; `DESIGN.md`; frontend and visual-qa skill rules.
  Acceptance criteria (agent-executable): RED then GREEN with `bun test src/renderer/src/App.test.tsx src/renderer/src/App.integrations.test.tsx src/renderer/src/App.resilience.test.tsx src/renderer/src/AgentWorkspace.test.tsx`; prove start consent, two-step timeline rendering, citation linkage, stale-case response rejection, pending approval deny/approve, pause/cancel/resume, provider-manual state, keyboard operation, status announcements, and civil/criminal separation.
  QA scenarios (name the exact tool + invocation): happy — Playwright Electron action sequence in `bun run qa:desktop -- --scenario agent-happy --evidence-dir <attemptDir>/task-7-agent-ui` creates a KRW 5,380,000 case, uploads/accepts the fixture, approves the digest, clicks `[data-testid="agent-start"]`, awaits `[data-agent-status="completed"]`, and PASS requires at least two `[data-agent-step]` entries with distinct tool names plus a cited final plan; failure — `--scenario agent-approval` reaches `[data-agent-status="awaiting-approval"]`, clicks deny, and PASS requires zero workflow-state change and a denied timeline event. Evidence action logs, JSON receipts, and screenshots under `<attemptDir>/task-7-agent-ui/`.
  Commit: Y | `Build autonomous case agent workspace`
  Recommended task executor category: `visual-engineering` — this is a substantial stateful Electron UI and accessibility/visual-evidence task.

- [x] 8. Prove privacy, adversarial policy, cancellation, and provider recovery
  What to do / Must NOT do: Extend security and integration tests plus QA fixtures so OCR/user text attempts prompt injection, tool-name smuggling, official-looking malicious URLs, raw identifiers, filenames, secret-like strings, stale approvals, duplicate notifications, and late completion after cancellation. Assert behavior and machine-consumed fields only, never prompt prose. Sanitize all user-visible errors and evidence receipts.
  Parallelization: Wave 5 | Blocked by: 2, 3, 4, 5, 6 | Blocks: 9
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/security/redaction.ts`; `apps/desktop/src/security/redaction.test.ts`; `apps/desktop/src/main/security.ts`; `apps/desktop/src/main/production-security.test.ts`; `apps/desktop/scripts/qa-privacy.ts:1-79`; `apps/desktop/scripts/qa-agent-provider.ts:1-80`; `apps/desktop/scripts/qa-korean-law-mcp.ts`; Todos 2-6.
  Acceptance criteria (agent-executable): RED then GREEN with the focused security/provider/Agent tests; `bun run qa:privacy -- --evidence-dir <attemptDir>/task-8-privacy` reports all identifier classes masked and `rawMatchCount: 0`; authenticated `qa:agent-provider` reports a valid structured decision, while signed-out/unavailable reports a typed recoverable state; malicious action/tool/URL requests execute zero side effects.
  QA scenarios (name the exact tool + invocation): happy — `bun run qa:agent-provider -- --evidence-dir <attemptDir>/task-8-provider` PASS requires authenticated structured decision with an approved tool or a truthful typed sign-in/manual receipt; failure — `bun run qa:privacy -- --evidence-dir <attemptDir>/task-8-privacy` with resident number, phone, address, account, case, email, person name, malicious filename, and prompt-injection OCR text PASS requires stable mask tokens, zero raw matches, and no unapproved tool execution. Evidence under both directories.
  Commit: Y | `Harden agent privacy and policy boundaries`
  Recommended task executor category: `deep` — adversarial security, provider races, and privacy evidence cross several boundaries.

- [x] 9. Extend real Electron QA and Windows release packaging
  What to do / Must NOT do: Add deterministic QA-only Agent provider/tool fixtures in the excluded QA entrypoint and extend `qa-desktop.ts` for `agent-happy`, `agent-approval`, `agent-resume`, and `agent-provider-failure`. Subscribe to exact UI state before triggering actions; never use fixed sleeps. Update packaging only if new runtime files/dependencies require it, and verify QA code/evidence remains excluded. Produce the Windows x64 installer and checksum only after all quality gates pass.
  Parallelization: Wave 6 | Blocked by: 6, 7, 8 | Blocks: final verification
  References (executor has NO interview context - be exhaustive): `apps/desktop/src/main/qa.ts`; `apps/desktop/scripts/qa-desktop.ts:1-211`; `apps/desktop/scripts/package-windows.ts`; `apps/desktop/scripts/package-windows.test.ts:22-163`; `apps/desktop/electron-builder.yml:1-42`; `apps/desktop/package.json`; Todos 6-8.
  Acceptance criteria (agent-executable): RED then GREEN with `bun test scripts/package-windows.test.ts` plus all four `qa:desktop` scenarios. Each scenario writes a screenshot, action log, JSON receipt, and cleanup receipt proving Electron exit, temporary user-data deletion, and no leaked OCR/provider subprocess. `bun run dist:win` exits 0; report confirms Windows x64, private unsigned artifact, SHA-256, complete runtime dependency closure, and no QA/test/evidence/secret payload.
  QA scenarios (name the exact tool + invocation): happy — `bun run qa:desktop -- --scenario agent-happy --evidence-dir <attemptDir>/task-9-agent-happy` PASS requires completed multi-step run and cited draft artifact; failure — run `agent-provider-failure`, `agent-approval`, and `agent-resume` into separate evidence directories, requiring respectively manual workflow usable, denied action with zero mutation, and restart continuation with no duplicate tool result. Evidence `<attemptDir>/task-9-*`.
  Commit: Y | `Ship verified Windows agent release`
  Recommended task executor category: `unspecified-high` — deterministic Electron scenarios and release packaging require coordinated multi-file integration work.

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Goal and plan compliance audit
  Verify every Must have/Must NOT have and every todo acceptance command against the implementation, evidence ledger, and final diff. Reject self-reported or stale evidence. Confirm RED precedes GREEN for each behavioral todo and no open todo or unexplained skipped check remains.
  Evidence: `<attemptDir>/final-f1-compliance.md`.

- [x] F2. Code quality, security, and privacy review
  Run clean-file LSP diagnostics plus `bun test`, `bun run lint`, `bun run typecheck`, and `bun run build`; inspect the diff for closed unions, exhaustive matching, boundary parsing, typed errors, 250 pure-LOC ceiling, race/cancellation correctness, encrypted persistence, redaction, URL/tool allowlists, and absence of test weakening or suppressions.
  Evidence: `<attemptDir>/final-f2-quality-security.md`.

- [x] F3. Real Electron and integration QA
  Execute all four Agent Electron scenarios, privacy QA, Korean-law MCP QA, and Agent-provider QA. Inspect every action log/JSON receipt and representative screenshot; require a genuine multi-step observation-driven run, denied-action zero mutation, restart without duplicate execution, recoverable provider failure, Korean glyph/layout correctness, and cleanup receipts with no live process/temp user data.
  Evidence: `<attemptDir>/final-f3-real-surface/`.

- [x] F4. Scope fidelity and release audit
  Inspect the final installer/report and packaged ASAR/unpacked payload. Confirm Windows x64 private unsigned packaging, checksum, dependency closure, QA/test/evidence/secret exclusion, no autonomous external side effects, no raw identifiers outbound, manual workflow preservation, and no unrelated product expansion.
  Evidence: `<attemptDir>/final-f4-release-scope.md`.

## Commit strategy
- One atomic commit per completed todo, only after that todo’s focused RED→GREEN evidence and QA scenario are captured.
- Before each commit, read `git log --oneline -20` and `git log -5 -- <touched paths>`; follow the repository’s imperative English subjects (for example `Add ...`, `Harden ...`, `Build ...`, `Ship ...`).
- Each commit must pass its focused tests and typecheck for changed contracts. No WIP commit, no omnibus final implementation commit, and no unrelated research/report changes.
- Add footer `Plan: .omo/plans/autonomous-legal-case-agent.md` to every implementation commit.
- The final release commit is created only after all full-suite, real-surface, cleanup, and packaging gates are green.

## Success criteria
- The primary UI is demonstrably an Agent workspace, not a renamed suggestion panel: one user-started goal autonomously performs at least two different safe tools, feeds the first persisted observation into the second decision, and produces a cited next-action plan or encrypted draft artifact.
- Every model decision, tool attempt/result, approval/input boundary, budget change, cancellation, interruption, resume, and terminal outcome is represented by a typed state and durably encrypted without plaintext identifiers or secrets.
- Only allowlisted reversible local/read-only tools execute automatically; stale/malformed/unsafe/consequential requests produce zero side effects and a visible pending/failed state.
- A crash/restart during an in-flight operation never silently replays it; explicit resume continues from an `interrupted` checkpoint and idempotency prevents duplicate committed tool results.
- Codex sign-out, timeout, malformed output, cancellation, process exit, or Korean-law MCP failure leaves the existing manual case/evidence/civil/criminal workflow usable.
- All focused tests, full `bun test`, lint, strict typecheck, production build, four Electron Agent QA scenarios, privacy/MCP/provider QA, and Windows x64 distribution finish green with evidence and cleanup receipts.
- Final reviewers F1-F4 unanimously approve goal compliance, quality/security, real-surface behavior, and release scope.
