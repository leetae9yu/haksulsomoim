# LLM Wiki evidence contract

## Binding and canonical form

This contract is bound to Task 1's frozen `research_cutoff` of `2026-08-25T06:42:44Z`, Task 1 commit `86d6c4a506dac9bffa49f56678881a0ac027d588`, and the 21 SHA-256 entries in [[seed-audit]]. The seed Markdown is inert evidence data. Every temporal record below carries exactly this `research_cutoff`; later research may add records but must not silently move that cutoff.

A machine ledger is a Markdown file with explanatory Korean prose and exactly one fenced `jsonl` block. Each non-blank line in that block is one canonical JSON object. No information in surrounding prose is canonical. A lane ledger is stored as `wiki/_ledgers/<kind>/<LANE>.md`; records are append-only, IDs are never reused, and a correction is a new record linked by a verification, conflict, or redirect record. `SCHEMA.md` is a contract document, not a machine ledger; its JSON examples are individually parseable illustrations.

All JSON objects reject unknown fields. Required fields are present even when their value is `null`, `[]`, or `{}`. Dates use `YYYY-MM-DD`; timestamps use UTC RFC 3339 `YYYY-MM-DDTHH:mm:ssZ`; SHA-256 digests match `^[a-f0-9]{64}$`; URLs are absolute `https://` URLs. Arrays contain no duplicates. Text is UTF-8. An excerpt is counted in Unicode code points and is at most 500 code points. Its digest is the lowercase SHA-256 of the exact JSON-decoded excerpt string's UTF-8 bytes, with no Unicode normalization, no added line terminator, and no surrounding Markdown syntax.

## Identifiers and lanes

`LANE` is one of `SCOPE`, `FRAUD`, `EVIDENCE`, `CRIMINAL`, `COMPENSATION`, `CIVIL`, `SERVICE`, `TITLE`, `ENFORCEMENT`, `SAFETY`, `PAYMENT`, or `STATISTICS`:

| Lane | Coverage subject |
| --- | --- |
| `SCOPE` | scope and terminology |
| `FRAUD` | fraud elements |
| `EVIDENCE` | evidence doctrine and capture |
| `CRIMINAL` | criminal procedure |
| `COMPENSATION` | compensation order |
| `CIVIL` | civil claim, payment order, and small claims |
| `SERVICE` | identity, jurisdiction, and service |
| `TITLE` | judgment, finality, and enforceable title |
| `ENFORCEMENT` | enforcement, insolvency, and recovery |
| `SAFETY` | privacy, legal-service, and AI boundaries |
| `PAYMENT` | payment and platform branches |
| `STATISTICS` | statistics, prevention, and lived-experience traces |

The symbolic forms are `SRC-<LANE>-NNNN`, `OBS-<LANE>-NNNN`, and `CLM-<LANE>-NNNN`, where `NNNN` is four decimal digits. Their stable patterns are `^SRC-(SCOPE|FRAUD|EVIDENCE|CRIMINAL|COMPENSATION|CIVIL|SERVICE|TITLE|ENFORCEMENT|SAFETY|PAYMENT|STATISTICS)-[0-9]{4}$`, `^OBS-(SCOPE|FRAUD|EVIDENCE|CRIMINAL|COMPENSATION|CIVIL|SERVICE|TITLE|ENFORCEMENT|SAFETY|PAYMENT|STATISTICS)-[0-9]{4}$`, and `^CLM-(SCOPE|FRAUD|EVIDENCE|CRIMINAL|COMPENSATION|CIVIL|SERVICE|TITLE|ENFORCEMENT|SAFETY|PAYMENT|STATISTICS)-[0-9]{4}$`. The companion patterns are `^VRF-[0-9]{4}$`, `^CNF-[0-9]{4}$`, `^RDR-[0-9]{4}$`, `^COV-(SCOPE|FRAUD|EVIDENCE|CRIMINAL|COMPENSATION|CIVIL|SERVICE|TITLE|ENFORCEMENT|SAFETY|PAYMENT|STATISTICS)-[0-9]{4}$`, `^SAT-[0-9]{4}$`, and `^SED-[0-9]{4}$`.

## Legacy note contract

Legacy frontmatter is immutable as a key contract: no canonical provenance field belongs in a P, R, or index note. Keys appear once, in the listed order, and no other frontmatter key is allowed.

| Note kind | Exact keys | Identifier rule |
| --- | --- | --- |
| P | `id`, `유형`, `사건명`, `법원_출처`, `사건번호`, `수법유형`, `자료유형`, `출처`, `tags` | frozen Task 1 `P1` through `P10` |
| R | `id`, `유형`, `사건명`, `절차구분`, `진행상태`, `결과유형`, `수법유형`, `자료유형`, `출처`, `tags` | frozen Task 1 `R1` through `R10` |
| index | `id`, `유형`, `제목`, `tags` | frozen Task 1 `INDEX-0001` |
| appendix | `id`, `유형`, `제목`, `tags` | authoritative `APPENDIX-0001` |

For P and R notes, the body has one H1 `# 개요`, then one H1 `# 처리과정`, then one H1 `# 결과`, in that order. `# 비고` is optional, occurs at most once, and follows `# 결과`; the downloaded P1-P3/R1 records omit it and the remaining seed records may retain it. No other H1 is allowed. The index retains its four ordered H1 headings: `# 판례 10선 (형사 확정판결 및 관련 보도)`, `# 해결사례 10선 (피해자가 실제로 밟은 절차)`, `# 참고 자료`, and `# 자료유형 신뢰도 구분 안내`.

An Obsidian link is exactly `[[<filename-stem>]]` or `[[<filename-stem>|<display text>]]`, has no path traversal, and resolves to one Markdown filename stem in `wiki/`. P/R IDs, filenames, these headings, and resolved links are immutable identities. A factual conclusion in a rendered note uses inline `[CLM-... ]` without frontmatter changes; whitespace before the closing bracket is forbidden, so the canonical form is `[CLM-LANE-NNNN]`.

## Shared enumerations

- `source_class`: `primary_official_statute`, `primary_official_judgment`, `primary_official_court_rule_or_form`, `primary_official_agency_guidance`, `primary_official_statistics`, `secondary_academic`, `secondary_news`, `secondary_professional`, `platform_policy`, `anecdote`, `search_snippet`, `ai_summary`, `metadata_only`, `inaccessible`, `repository_artifact`.
- `access_state`: `full_text`, `partial_text`, `metadata_only`, `inaccessible`, `discovery_only`, `repository_snapshot`.
- `quotation_license_basis`: `public_law`, `public_judgment`, `government_publication`, `fair_quotation`, `permission`, `no_quotation`.
- `confidence`: `high`, `medium`, `low`.
- `evidence_status`: `candidate`, `reported`, `verified`, `gap`, `rejected`.
- `publication_status`: `draft`, `published`, `withheld`, `superseded`.
- `scope_fit`: `target`, `context_only`, `out_of_scope`, `unknown`.

`search_snippet`, `ai_summary`, `metadata_only`, and `inaccessible` sources are discovery-only and cannot support a `verified` claim. `secondary_news`, `secondary_professional`, `platform_policy`, and `anecdote` likewise cannot alone support `verified`. Copied or syndicated material shares one non-empty `independence_group` string.

## Record schemas and examples

### Source

A `source` has exactly: `record_type`, `id`, `lane`, `research_cutoff`, `source_class`, `institution`, `canonical_url`, `identifier`, `publication_date`, `effective_date`, `accessed_at`, `access_state`, `independence_group`, `quotation_license_basis`, `confidence`, `caveats`, `content_sha256`, and optional-null `repository_commit`, `repository_path`, `repository_blob_sha256`. For `repository_artifact`, `canonical_url` is `repo://wiki/<path>`, access is `repository_snapshot`, all three repository fields and `content_sha256` are exact non-null values, and the two content digests match. Non-repository sources leave those fields absent or null. `institution` and `identifier` are non-empty strings; date fields are date or `null`; `accessed_at` is a timestamp; `caveats` is an array of non-empty strings; `content_sha256` is a SHA-256 or `null` when no text was lawfully retained.

```json
{"record_type":"source","id":"SRC-SCOPE-0001","lane":"SCOPE","research_cutoff":"2026-08-25T06:42:44Z","source_class":"primary_official_agency_guidance","institution":"Example Public Institution","canonical_url":"https://example.go.kr/guidance","identifier":"GUIDE-1","publication_date":"2026-01-01","effective_date":"2026-01-01","accessed_at":"2026-08-25T06:42:44Z","access_state":"full_text","independence_group":"example-public-institution-guidance","quotation_license_basis":"government_publication","confidence":"high","caveats":[],"content_sha256":null}
```

### Observation

An `observation` has exactly: `record_type`, `id`, `lane`, `research_cutoff`, `source_id`, `locator_type`, `locator`, `excerpt`, `captured_at`, `excerpt_digest`, `caveats`. `locator_type` is `article`, `section`, `paragraph`, `page`, `table`, `heading`, `search_result`, `metadata`, or `repository_record`; `locator` is non-empty; `excerpt` is non-empty and at most 500 Unicode code points; `captured_at` is a timestamp; `excerpt_digest` is the lowercase SHA-256 of the exact UTF-8 excerpt bytes under the contract-wide no-normalization/no-line-terminator rule. A `search_result` or `metadata` observation cannot support `verified`.

```json
{"record_type":"observation","id":"OBS-SCOPE-0001","lane":"SCOPE","research_cutoff":"2026-08-25T06:42:44Z","source_id":"SRC-SCOPE-0001","locator_type":"heading","locator":"Scope heading","excerpt":"This example demonstrates a short, attributable observation.","captured_at":"2026-08-25T06:42:44Z","excerpt_digest":"97468fa2d8d082904c177d169371c6e13d4b4f3e561ee2e458ce889d7d7d704d","caveats":[]}
```

### Claim

A `claim` has exactly: `record_type`, `id`, `lane`, `research_cutoff`, `claim_type`, `statement`, `evidence_status`, `publication_status`, `scope_fit`, `temporal_scope`, `supporting_observation_ids`, `counter_observation_ids`, `derived_from_claim_ids`, `case_family_id`, `confidence`, `caveats`, and optional-null `repository_binding`. `claim_type` is `terminology`, `legal_rule`, `procedural_rule`, `evidence_guidance`, `factual_case`, `service_policy`, `statistic`, `prevention`, `judgment`, `service`, `finality`, `enforceable_title`, `enforcement_action`, `debtor_registry_entry`, `actual_payment`, `derived_synthesis`, or `repository_audit`. `temporal_scope` is exactly `{ "start_date": date-or-null, "end_date": date-or-null, "as_of_date": date-or-null }`.

A claim is atomic: a claim type of `repository_audit` carries a `repository_binding` with the exact source ID, observation ID, and observation digest, has one direct repository observation, and is limited to current tracked repository facts. It cannot assert legal truth, user outcome, recovery, or product effectiveness. A claim type of `judgment`, `service`, `finality`, `enforceable_title`, `enforcement_action`, `debtor_registry_entry`, or `actual_payment` states only that state and never implies another. A claim with `derived_synthesis` has at least one `derived_from_claim_ids` value, has no supporting observations, and may be `verified` only when every reachable leaf claim is `verified`. A non-derived non-gap claim has at least one supporting observation. A `gap` claim has no supporting observations. `derived_from_claim_ids` must not contain the claim's own ID and the directed graph over all claims is acyclic. `actual_payment` requires payment evidence; a judgment, service, finality, title, enforcement action, registry entry, settlement promise, or agreement is not payment evidence.

```json
{"record_type":"claim","id":"CLM-SCOPE-0001","lane":"SCOPE","research_cutoff":"2026-08-25T06:42:44Z","claim_type":"terminology","statement":"This example claim defines the contract scope.","evidence_status":"reported","publication_status":"draft","scope_fit":"target","temporal_scope":{"start_date":null,"end_date":null,"as_of_date":"2026-08-25"},"supporting_observation_ids":["OBS-SCOPE-0001"],"counter_observation_ids":[],"derived_from_claim_ids":[],"case_family_id":null,"confidence":"medium","caveats":[]}
```

```json
{"record_type":"claim","id":"CLM-FRAUD-0001","lane":"FRAUD","research_cutoff":"2026-08-25T06:42:44Z","claim_type":"terminology","statement":"This example records an alternative scope definition as a documented gap.","evidence_status":"gap","publication_status":"draft","scope_fit":"context_only","temporal_scope":{"start_date":null,"end_date":null,"as_of_date":"2026-08-25"},"supporting_observation_ids":[],"counter_observation_ids":[],"derived_from_claim_ids":[],"case_family_id":null,"confidence":"low","caveats":["No source is asserted for this documented example gap."]}
```

### Verification

A `verification` has exactly: `record_type`, `id`, `research_cutoff`, `claim_id`, `method`, `outcome`, `observation_ids`, `reviewed_at`, `reviewer_role`, `caveats`. `method` is `source_identity`, `primary_source_trace`, `counter_search`, `date_recheck`, `manual_review`, or `automated_check`; `outcome` is `confirmed`, `contradicted`, or `insufficient`; `reviewer_role` is `researcher`, `reviewer`, or `validator`. A confirmed `primary_source_trace` references at least one observation.

```json
{"record_type":"verification","id":"VRF-0001","research_cutoff":"2026-08-25T06:42:44Z","claim_id":"CLM-SCOPE-0001","method":"manual_review","outcome":"confirmed","observation_ids":["OBS-SCOPE-0001"],"reviewed_at":"2026-08-25T06:42:44Z","reviewer_role":"reviewer","caveats":[]}
```

### Conflict

A `conflict` has exactly: `record_type`, `id`, `research_cutoff`, `claim_ids`, `conflict_type`, `status`, `resolution`, `resolved_by_verification_id`, `caveats`. `claim_ids` contains at least two claim IDs; `conflict_type` is `fact`, `legal_interpretation`, `temporal_validity`, `scope`, `statistic_definition`, or `source_identity`; `status` is `open`, `resolved`, or `superseded`; `resolution` is non-empty only for `resolved` or `superseded`; `resolved_by_verification_id` is a verification ID or `null`.

```json
{"record_type":"conflict","id":"CNF-0001","research_cutoff":"2026-08-25T06:42:44Z","claim_ids":["CLM-SCOPE-0001","CLM-FRAUD-0001"],"conflict_type":"scope","status":"open","resolution":null,"resolved_by_verification_id":null,"caveats":["Example conflict for parser coverage."]}
```

### Redirect

A `redirect` has exactly: `record_type`, `id`, `research_cutoff`, `from_ref`, `to_ref`, `reason`, `status`. `from_ref` and `to_ref` are distinct IDs matching P/R/index/ledger patterns; `reason` is `renamed_note`, `superseded_claim`, `duplicate_source`, or `case_family_link`; `status` is `active` or `retired`. Redirects preserve the old identity and never delete it.

```json
{"record_type":"redirect","id":"RDR-0001","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"P1","to_ref":"CLM-SCOPE-0001","reason":"case_family_link","status":"active"}
```

### Coverage

A `coverage` record has exactly: `record_type`, `id`, `lane`, `research_cutoff`, `cell`, `status`, `required_source_class`, `claim_ids`, `source_ids`, `searched_at`, `gap_reason`, `caveats`. `status` is `verified`, `reported`, or `gap`; `required_source_class` is one source class; `cell` is non-empty. `verified` has at least one claim and source and `gap_reason` is `null`; `reported` has at least one claim and `gap_reason` is `null`; `gap` has empty claims and sources and a non-empty `gap_reason`.

```json
{"record_type":"coverage","id":"COV-SCOPE-0001","lane":"SCOPE","research_cutoff":"2026-08-25T06:42:44Z","cell":"scope-definition","status":"reported","required_source_class":"primary_official_agency_guidance","claim_ids":["CLM-SCOPE-0001"],"source_ids":["SRC-SCOPE-0001"],"searched_at":"2026-08-25T06:42:44Z","gap_reason":null,"caveats":["Contract example; research coverage is added by later lane work."]}
```

### Candidate inventory

A `candidate` has exactly: `record_type`, `id`, `research_cutoff`, `candidate_identity`, `lanes`, `status`, `disposition`, `material_novelty`, `occurrence_ids`, `caveats`. Its ID is `CAD-*`; `candidate_identity` is globally unique; nullable lane entries preserve discoveries that were not assigned to a lane; `status` is `terminal` or `queued`; `disposition` is `accepted_existing`, `accepted_reported`, `rejected_irrelevant`, `rejected_weak`, `duplicate_confirmation`, `explicit_gap`, `access_gap`, `bounded_context`, or `superseded_by_canonical`; and each `CAO-*` occurrence ID links exactly once.

A `candidate_occurrence` has exactly: `record_type`, `id`, `research_cutoff`, `candidate_id`, `candidate_identity`, `source_occurrence_id`, `candidate_key`, `lane`, `origin_task`, `origin_type`, `origin_refs`, `evidence_refs`, `disposition`, `material_novelty`, `prompt_text_inert`, `resolved_at`. Its `candidate_id` and identity must match one canonical candidate record. `source_occurrence_id` preserves the ignored research receipt identity, while the globally unique `CAO-*` ID is the shipped provenance link. Every occurrence appears in exactly one candidate's `occurrence_ids` list.

Each `terminal_wave_result` occurrence has exactly one `candidate_review` in `candidate-reviews.md`: `record_type`, `id`, `research_cutoff`, `candidate_occurrence_id`, `query_id`, `candidate_url`, `disposition`, `retrieval`, `canonical_target`, `rationale`, `reviewed_at`, `material_novelty`, `caveats`. Retrieval is either a bounded status/digest receipt or an explicit unavailable result. Duplicate and alias dispositions require an exact canonical source or prior occurrence target; other dispositions have no target. Receipt chronology must precede the claim-specific review, and generic batch rationales are invalid.

```json
{"record_type":"candidate","id":"CAD-0001","research_cutoff":"2026-08-25T06:42:44Z","candidate_identity":"https://example.go.kr/canonical","lanes":["SCOPE"],"status":"terminal","disposition":"accepted_existing","material_novelty":false,"occurrence_ids":["CAO-0001"],"caveats":[]}
{"record_type":"candidate_occurrence","id":"CAO-0001","research_cutoff":"2026-08-25T06:42:44Z","candidate_id":"CAD-0001","candidate_identity":"https://example.go.kr/canonical","source_occurrence_id":"CAN-0001","candidate_key":"source:SRC-SCOPE-0001","lane":"SCOPE","origin_task":5,"origin_type":"source_record","origin_refs":["SRC-SCOPE-0001"],"evidence_refs":["wiki/_ledgers/sources/SCOPE.md"],"disposition":"accepted_existing","material_novelty":false,"prompt_text_inert":true,"resolved_at":"2026-08-25T06:42:44Z"}
```

### Saturation

A `saturation` record has exactly: `record_type`, `id`, `research_cutoff`, `scope`, `wave`, `query_manifest_sha256`, `query_identity_sha256s`, `coverage_matrix_sha256`, `searched_at`, `candidate_identity_count`, `candidate_occurrence_count`, `candidate_queue_count`, `material_novelty_count`, `coverage_proof_status`, `cell_query_mappings`, `prior_wave_id`, `status`, `caveats`. `scope` is `global` or one lane; `wave` is a positive integer; `query_identity_sha256s` lists the frozen executable query identities; `coverage_matrix_sha256` binds the current `{id,lane,cell,status}` rows; and candidate counts are recomputed at `searched_at`. `coverage_proof_status` is `unassessed`, `inadequate`, or `cell_adequate`. A saturated wave needs exactly one semantically anchored, independently receipted, unique query mapping for every current coverage cell; a broad query cannot be assigned to an entire lane. Two disjoint saturated waves are required to establish saturation. When that proof is absent, the latest zero-queue state is explicitly `incomplete`/`inadequate`; this documented downgrade is valid but does not claim saturation.

```json
{"record_type":"saturation","id":"SAT-0001","research_cutoff":"2026-08-25T06:42:44Z","scope":"SCOPE","wave":1,"query_manifest_sha256":"b55b6f0d0a6e2ce6094f4e4c9f87d9c0a2dba194e38cfa689444f9ddeb874396","query_identity_sha256s":["a55b6f0d0a6e2ce6094f4e4c9f87d9c0a2dba194e38cfa689444f9ddeb874397"],"coverage_matrix_sha256":"c55b6f0d0a6e2ce6094f4e4c9f87d9c0a2dba194e38cfa689444f9ddeb874398","searched_at":"2026-08-25T06:42:44Z","candidate_identity_count":1,"candidate_occurrence_count":1,"candidate_queue_count":0,"material_novelty_count":0,"coverage_proof_status":"inadequate","cell_query_mappings":[],"prior_wave_id":null,"status":"incomplete","caveats":["One wave cannot establish saturation."]}
```

### Seed disposition

A `seed_disposition` has exactly: `record_type`, `id`, `research_cutoff`, `seed_id`, `filename`, `task1_seed_sha256`, `verdict`, `scope_fit`, `source_quality`, `missing_urls`, `factual_conflicts`, `duplicate_family`, `primary_follow_up`, `intended_destination`, `caveats`. `verdict` is `keep`, `augment`, `context_only`, `unverified`, or `replace_content_keep_id`; `source_quality` is `primary`, `secondary`, `anecdotal`, `mixed`, or `unknown`; `missing_urls` and `factual_conflicts` are arrays of non-empty strings; `duplicate_family` is a string or `null`; `primary_follow_up` is a non-empty string; `intended_destination` is a non-empty wiki-relative path.

```json
{"record_type":"seed_disposition","id":"SED-0001","research_cutoff":"2026-08-25T06:42:44Z","seed_id":"P1","filename":"P1_렌탈가전_속여_판_중고거래_사기.md","task1_seed_sha256":"c001439894aa7409085927d405145382b074eb1518a71bfb2fc0e714d83e90ba","verdict":"unverified","scope_fit":"unknown","source_quality":"secondary","missing_urls":[],"factual_conflicts":[],"duplicate_family":null,"primary_follow_up":"Locate an official judgment or record a searched gap.","intended_destination":"wiki/P1_렌탈가전_속여_판_중고거래_사기.md","caveats":["Contract example; the complete audit is maintained in the seed-disposition ledger."]}
```

## Graph and publication rules

References use their declared patterns and must resolve within the ledger corpus before a record is published. Source-to-observation-to-claim is the evidence path. Counter-observations do not become supporting evidence by implication. A `verified` claim needs a full-text observation from an eligible source, current temporal coverage, and a confirming verification; `reported` preserves a trace without asserting it as verified; `gap` documents a searched absence. Numerical claims additionally state unit, population, period, metric definition, and qualification in their `statement` or a linked observation.

Claim graph cycle checking is deterministic depth-first traversal over `derived_from_claim_ids`: entering a gray node rejects the record set with `derived-claim-cycle`. The check runs before publication and after every append. No automatic fuzzy merge is allowed for anonymous cases.

## Repository audit evidence

Task 13 repository-audit sources are checked against both the named Git commit blob and current parsed corpus bytes. A repository observation has one machine `repository_record_id`, `repository_fact_kind`, scalar `repository_selected_fields`, and `repository_fact_digest`; its locator equals that record ID and its excerpt is the canonical selected-fields object. `repository_audit` binding repeats the exact source, observation, fact kind, subject, record ID, fields, digest, and deterministic proposition template. Its identity tuple is the bound commit, repository path, record kind and ID, fact kind, subject ID, and key-sorted selected fields. SHA-256 of that canonical JSON provides a collision-checked 16-hex prefix: `OBS-AUDIT-<prefix>` and `CLM-AUDIT-<prefix>`. The full identity digest is stored on the observation and binding. One canonical claim and one automated confirmation carrying the fact digest exist per repository observation. A repository artifact mutation, path/hash/excerpt drift, record movement, field/subject/template drift, or unrelated observation substitution is a named hard validation failure.

## Public render contract

`public-render.md` is the sole tracked machine ledger for the public root render. It has exactly one `public_render` record, 23 `public_file` records, and one `public_citation` record for each current inline citation occurrence. A validator recomputes every root-file SHA-256 and every citation-containing paragraph SHA-256; the ledger is an explicit reviewed adjudication artifact, not a lexical inference.

A `public_render` record has exactly: `record_type`, `id`, `research_cutoff`, `rendered_at`, `task10_commit`, `coverage_sha256`, `seed_audit_sha256`, `seed_dispositions_sha256`, `caveats`. Its ID is `PRM-NNNN`; `task10_commit` is a 40-character lowercase Git SHA; each digest is SHA-256. `research_cutoff` stays frozen, while `rendered_at` is the truthful later RFC3339 UTC execution time; equality or an earlier render time is invalid.

A `public_file` record has exactly: `record_type`, `id`, `manifest_id`, `path`, `public_id`, `sha256`, `seed_id`, `seed_disposition_id`, `task1_seed_sha256`. Its ID is `PRF-NNNN`; `manifest_id` resolves to the sole public render; `path` is one root-relative Markdown filename; `public_id` is the exact frontmatter ID or `null` only for README; seed fields are the matching `seed_disposition` values or all `null` for README and appendix. Every one of the 23 required public filenames occurs exactly once.

A `public_citation` record has exactly: `record_type`, `id`, `manifest_id`, `path`, `paragraph_sha256`, `claim_id`, `evidence_status`, `publication_status`, `qualifier_class`, `locator`, `rationale`. Its ID is `PRC-NNNN`; `claim_id` resolves to a current claim; both statuses equal that claim's statuses; `qualifier_class` is one of `published`, `draft`, `reported`, `rejected`, `withheld`, or `context`; `locator` and `rationale` are short non-empty reviewed claim-relative text. The tuple `path`, `paragraph_sha256`, `claim_id` occurs exactly once, and exactly matches a current public inline citation occurrence.

## Report render contract

`report-render.md` is the tracked contract for `report.md` in structural mode (a corpus containing both seed dispositions and a public or report render). Structural mode requires exactly one `report.md`; fixtures before that surface are exempt. `report_render` has exactly: `record_type`, `id`, `research_cutoff`, `rendered_at`, `report_sha256`, `task10_commit`, `task11_commit`, `task12_commit`, `ledger_sha256s`, `required_sections`, `caveats`. Its ID is `RRM-NNNN`; it binds the exact report bytes, the three frozen 40-character commits, named ledger SHA-256 values, and the complete H2 section set.

Every factual paragraph and data table row has exactly one `report_assertion`: `record_type`, `id`, `manifest_id`, `path`, `section`, `kind`, `content_sha256`, `claim_bindings`. Its ID is `RRA-NNNN`; `path` is `report.md`; `kind` is `paragraph` or `table_row`; the digest covers the exact rendered block. Each binding has `claim_id`, current statuses, `qualifier_class`, a reviewed rationale, and optional `exact_statement`. Exact bindings require the cited claim statement to appear verbatim after citation markers are removed, preventing a valid but propositionally unrelated claim substitution. `report_render.rendered_at` follows the same truthful post-cutoff chronology rule as the public render. Missing, stale, duplicate, unregistered, or unrelated substitutions fail validation.
