# 학술소모임 소액사기 Agent

국내 계좌이체 소액사기 피해자가 Claude Code 또는 Codex에서 사건 사실과 증거를
정리하고, 형사·민사·집행 절차를 분리해 준비하도록 돕는 로컬 플러그인입니다.

이 플러그인은 법률대리나 자동 제출 도구가 아닙니다. 로그인, 본인인증, 법적 진술,
결제와 최종 제출은 항상 사용자가 직접 수행합니다.

## 포함 기능

- 질문형 사건 접수와 로컬 사건 카드
- 원본을 복사하지 않는 증거 파일 해시·인덱스
- 독립적인 형사·민사 진행 상태
- `korean-law-mcp`를 통한 공식 법령 조회
- Playwright·로컬 OCR 기반 Secure Computer
- 모델로 보내기 전 화면 개인정보 마스킹
- 관찰 digest에 결합된 클릭·입력·스크롤
- 인증·결제·송금·최종 제출의 사용자 인계

## 요구사항

- [Bun](https://bun.sh/) 1.3 이상
- Node.js 22 이상
- Claude Code 또는 Codex
- 실시간 법령 조회용 `LAW_OC`
- Secure Computer용 Chromium 계열 브라우저

Windows에서는 설치된 Microsoft Edge를 기본 사용합니다. 다른 환경에서는
`HAKSUL_BROWSER_EXECUTABLE`에 Chromium 실행 파일의 절대 경로를 지정할 수 있습니다.

## 준비

```bash
bun install
bun run build
bun run validate:plugin
bun test
bun run typecheck
bun run lint
```

`.env`에는 다음 값을 로컬로 설정하고 커밋하지 않습니다. Agent를 실행하는 터미널에도
같은 값을 환경변수로 내보내야 합니다.

```dotenv
LAW_OC=발급받은_법제처_OC
```

PowerShell:

```powershell
$env:LAW_OC = "발급받은_법제처_OC"
```

## Claude Code

공식 로컬 플러그인 실행 방식:

```bash
claude --plugin-dir /absolute/path/to/haksulsomoim/plugin
```

Claude Code 안에서 `/mcp`로 다음 서버가 연결됐는지 확인합니다.

- `plugin:haksulsomoim-small-fraud:haksulsomoim-local`
- `plugin:haksulsomoim-small-fraud:korean-law`

스킬은 다음 네임스페이스로 호출합니다.

```text
/haksulsomoim-small-fraud:small-fraud-agent
/haksulsomoim-small-fraud:small-fraud-secure-computer
```

## Codex

```bash
codex plugin marketplace add /absolute/path/to/haksulsomoim
codex plugin add haksulsomoim-small-fraud@haksulsomoim-local
codex plugin list
```

명령을 출력만 하고 실제 설정은 변경하지 않는 공용 설치 드라이런:

```bash
bun run install:local -- --target=both
```

Codex 설치까지 적용:

```bash
bun run install:local -- --target=codex --apply
```

Codex는 첫 세션에서 플러그인 런타임 의존성 설치 hook을 표시합니다. `/hooks`에서
`npm install --ignore-scripts --omit=dev` 명령과 플러그인 경로를 확인한 뒤 신뢰해야
MCP 서버가 시작됩니다. Claude Code는 플러그인의 Node.js 의존성 설치 방식을 사용합니다.

## 로컬 데이터

사건 정보는 프로젝트의 `.haksulsomoim/cases/` 아래에 저장되며 Git에서 무시됩니다.
증거 원본은 복사하거나 업로드하지 않고 경로와 SHA-256만 기록합니다. 기본 보안
경계에서는 `.haksulsomoim/cases/incoming/` 아래의 일반 파일만 인덱스할 수 있습니다.
MCP 응답은 사건 설명과 상대방 표시를 `[MASKED]`로 반환합니다.

## 환경변수

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `LAW_OC` | 없음 | Korean-law MCP 인증 |
| `HAKSUL_CASES_DIR` | `.haksulsomoim/cases` | 사건 저장 폴더 |
| `HAKSUL_SECURE_COMPUTER_HOSTS` | `ecfs.scourt.go.kr,law.go.kr` | 브라우저 허용 호스트 |
| `HAKSUL_BROWSER_EXECUTABLE` | Windows Edge 또는 Playwright 기본값 | 브라우저 경로 |
| `HAKSUL_CASE_ID` | 임의 세션 ID | 마스킹 토큰 범위 |

## 자동 검증

```bash
bun run validate:plugin
bun run qa:mcp
bun run qa:law
bun run qa:secure-computer
bun run qa:ocr
bun run qa:court
bun run build
```

사용자 수동 QA 절차는 `docs/MANUAL_QA.md`에 있습니다.
마스킹 PNG를 직접 검수한 시각 QA 보고서는
[`docs/qa/2026-08-22-secure-computer/README.md`](docs/qa/2026-08-22-secure-computer/README.md)에
있습니다.

## 공식 패키징 문서

- [Claude Code plugins](https://code.claude.com/docs/en/plugins.md)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp.md)
- [Codex skills](https://developers.openai.com/codex/skills.md)
- [Codex MCP](https://developers.openai.com/codex/mcp.md)
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins.md)
