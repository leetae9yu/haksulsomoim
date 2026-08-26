# Canonical redirects

Task 10 canonicalization preserves every lane ID while directing duplicate source identities to one canonical source record. Article-specific alias records remain valid observation targets; redirects prevent them from being counted as independent sources.

```jsonl
{"record_type":"redirect","id":"RDR-1001","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-COMPENSATION-0005","to_ref":"SRC-CRIMINAL-0003","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1002","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-EVIDENCE-5001","to_ref":"SRC-CRIMINAL-0003","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1003","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-SERVICE-0002","to_ref":"SRC-CIVIL-0001","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1004","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-SERVICE-0003","to_ref":"SRC-CIVIL-0001","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1005","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-TITLE-0001","to_ref":"SRC-CIVIL-0001","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1006","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-TITLE-0002","to_ref":"SRC-CIVIL-0001","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1007","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-TITLE-0004","to_ref":"SRC-CIVIL-0001","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1008","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-TITLE-0006","to_ref":"SRC-CIVIL-0001","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1009","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-TITLE-0005","to_ref":"SRC-SERVICE-0004","reason":"duplicate_source","status":"active"}
{"record_type":"redirect","id":"RDR-1010","research_cutoff":"2026-08-25T06:42:44Z","from_ref":"SRC-ENFORCEMENT-0001","to_ref":"SRC-TITLE-0003","reason":"duplicate_source","status":"active"}
```
