# F4 localized README audit fix verification

- HEAD: 1515cba2af00b43e0f82196cb8cde723dbfa5078
- Full Bun: 342 passed, 0 failed
- Package tests: 32 passed, 0 failed
- Lint/typecheck/build: PASS
- Privacy/provider/law QA: PASS
- Electron happy/provider-failure routes: PASS under xvfb-run node
- Fresh NSIS/7z/ASAR extraction: PASS
- ASAR entries: 3473; forbidden/stale/bin/command/QA/test/evidence/secrets/source/docs/CLI/server: 0 by release audit
- Runtime imports and Windows x64 binary closure: PASS; 16 PE x64 binaries, 0 ELF/Mach-O
- Installer: regular file, one link, opc:opc, 0600, 280418610 bytes
- SHA-256: 1d4893297c590644fa2b9fbbc2f731e1773a2b068b635382e70dafc92351d8c3
- Temporary extraction, QA, Electron, and process roots cleaned.
