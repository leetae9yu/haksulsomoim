# 사용자 수동 QA

이 문서는 자동 검증이 모두 통과한 뒤 사용자가 Claude Code와 Codex에서 직접 확인할
최종 절차입니다. 실제 제출, 결제, 인증은 테스트하지 않습니다.

## 준비

1. 저장소 루트에서 `bun install`을 실행합니다.
2. `bun run build`로 `plugin/` 배포 디렉터리를 생성합니다.
3. `LAW_OC`가 로컬 `.env`에 있고 Git에 포함되지 않았는지 확인한 뒤 Agent를 실행할
   터미널의 환경변수로도 설정합니다.
4. Windows가 아니면 `HAKSUL_BROWSER_EXECUTABLE`을 Chromium 절대 경로로 지정합니다.
5. 실제 개인정보가 없는 테스트 증거 이미지와 텍스트 파일을 준비합니다.

## Claude Code

```bash
claude --plugin-dir /absolute/path/to/haksulsomoim/plugin
```

1. `/mcp`에서 `haksulsomoim-local`과 `korean-law`가 연결됐는지 확인합니다.
2. `/haksulsomoim-small-fraud:small-fraud-agent`를 호출합니다.
3. 다음 테스트 사실을 입력합니다.

   ```text
   2026-08-01 국내 계좌이체로 5,380,000원을 송금한 소액사기 사건을 정리하고 싶다.
   ```

4. Agent가 짧은 번호형 질문을 하고, 확인 전 사실을 저장하지 않는지 확인합니다.
5. 사건 생성 후 `.haksulsomoim/cases/case-*`에 `record.json`, `timeline.md`,
   `evidence.md`, `criminal.md`, `civil.md`가 생성되는지 확인합니다.
6. 법률 설명에 국가법령정보센터 공식 출처가 붙는지 확인합니다.

## Codex

```bash
codex plugin marketplace add /absolute/path/to/haksulsomoim
codex plugin add haksulsomoim-small-fraud@haksulsomoim-local
codex
```

Claude Code와 같은 테스트 사실로 다음을 확인합니다.

1. `/hooks`에서 플러그인의 `npm install --ignore-scripts --omit=dev` hook 경로와
   명령을 확인하고 신뢰합니다.
2. `small-fraud-agent` 스킬이 발견됩니다.
3. 사건 카드 MCP 도구가 로컬 파일을 생성합니다.
4. 형사 단계 변경이 민사 단계에 영향을 주지 않습니다.
5. 이전 단계로 되돌리는 요청은 거부됩니다.

## Secure Computer

실제 로그인 전 공개 페이지에서만 확인합니다.

1. `small-fraud-secure-computer` 스킬을 명시적으로 호출합니다.
2. `https://ecfs.scourt.go.kr` 공개 페이지를 관찰합니다.
3. 관찰 결과에 실제 전화번호·계좌번호가 포함되지 않는지 확인합니다.
4. 한 번 행동한 뒤 이전 observation digest로 다시 행동하면 거부되는지 확인합니다.
5. 로그인, 공동인증서, 결제 또는 최종 제출 버튼을 요청합니다.
6. Agent가 실행하지 않고 사용자 인계 메시지를 출력하는지 확인합니다.
7. 브라우저 세션을 닫은 후 마스킹 토큰을 다시 사용할 수 없는지 확인합니다.

## 증거 처리

1. 테스트 파일을 `.haksulsomoim/cases/incoming/` 아래에 두고 사건 증거로 추가합니다.
2. 사건 폴더에 원본 파일이 복사되지 않았는지 확인합니다.
3. `record.json`에는 경로, 설명, 종류, SHA-256만 저장됐는지 확인합니다.
4. 원본 파일이 사건 저장 루트 내부이거나 심볼릭 링크면 거부되는지 확인합니다.

## 통과 기준

- 두 Agent에서 같은 두 스킬과 같은 MCP 도구가 보입니다.
- 사건 원본 사실은 MCP 응답에서 `[MASKED]` 처리됩니다.
- 형사·민사 상태는 독립적이며 앞으로만 이동합니다.
- 법령 답변은 공식 출처를 제공합니다.
- 인증·결제·법적 진술·최종 제출은 실행되지 않습니다.
- 종료 후 브라우저와 MCP 프로세스가 남지 않습니다.

실패 시 실행한 Agent, 운영체제, 실패 단계, 화면에 표시된 오류, 생성된 사건 ID만
기록합니다. 실제 개인정보나 `LAW_OC` 값은 공유하지 않습니다.
