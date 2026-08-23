# Windows 사용자 수동 QA

이 문서는 자동 검증이 끝난 플러그인을 Windows 노트북에서 실제로 설치하고 사용하는
최종 QA 절차다. 실행자는 사람일 수도 있고 별도의 coding agent일 수도 있다. 이
문서만 읽고 준비, 실행, 판정, 증거 정리까지 완료할 수 있어야 한다.

이 runbook은 현재 내용이 `main`에 merge된 뒤 실행한다. 문서를 읽던 작업 branch에서
중간에 `main`으로 전환해 문서가 사라진 상태로 진행하지 않는다.

실제 제출, 결제, 로그인, 본인인증 또는 법적 진술은 테스트하지 않는다. 자동 테스트가
통과해도 Claude Code 또는 Codex에서 플러그인을 실제로 사용하지 않았다면 이 QA는
통과한 것이 아니다.

## 에이전트에게 전달할 지시문

다음 문장을 저장소에서 작업할 agent에게 그대로 전달할 수 있다.

```text
docs/MANUAL_QA.md를 처음부터 끝까지 읽고 Windows QA runbook을 실행해.
실제 개인정보와 실제 사건 자료는 사용하지 말고 문서의 합성 fixture만 사용해.
자동 검증뿐 아니라 host agent에서 두 skill과 Secure Computer를 직접 사용해.
로그인, 인증, 결제, 법적 진술, 송금, 최종 제출은 실행하지 말고 사용자 인계가
작동하는지만 확인해. 기존 변경을 버리거나 stash/reset하지 마.
마지막에는 문서의 REPORT.md 양식으로 PASS/FAIL/BLOCKED와 증거 경로를 보고해.
설치, credential 입력 또는 사용자 판단이 필요한 경계에서만 한 번에 하나씩 물어봐.
```

## 완료 계약

실행자는 다음을 모두 완료해야 한다.

1. Windows, Git, Node.js, Bun, host agent와 Edge 상태를 기록한다.
2. 깨끗한 `main`에서 plugin build와 자동 검증을 실행한다.
3. Claude Code에서 사건 접수와 Secure Computer를 실제로 사용한다.
4. 시작할 때 Codex QA 포함 여부를 사용자에게 확인하고 그 결정을 기록한다. 포함하기로
   했고 사용자가 설정 변경을 허용하면 Codex에서도 같은 표면을 확인한다.
5. 인증·결제·최종 제출이 실행되지 않고 사용자 인계로 끝나는지 확인한다.
6. `.haksulsomoim/qa/<timestamp>/REPORT.md`에 판정과 증거를 남긴다.
7. 자신이 시작한 browser와 MCP process를 종료하고 secret 환경변수를 지운다.

## 안전 경계

### 반드시 지킬 것

- 이 문서의 합성 사건과 합성 증거만 사용한다.
- `LAW_OC` 값, 계좌번호, 전화번호, 주민등록번호와 인증 정보를 log나 screenshot에
  남기지 않는다.
- login, 공동인증서, payment, 송금, 법적 진술과 최종 제출은 사용자가 직접 한다.
- 공개 페이지 밖으로 이동해야 하면 행동하지 말고 사용자 인계를 확인한다.
- 작업트리가 dirty이면 사용자 변경을 reset, checkout, clean, stash하지 않는다.
- 실패한 테스트를 삭제, skip 또는 완화하지 않는다.
- 기존 Node 또는 Edge process를 일괄 종료하지 않는다. 자신이 시작한 process만
  종료한다.
- QA evidence와 합성 사건은 Git에 commit하지 않는다.

### 사용자 확인이 필요한 것

- 누락된 global dependency 설치
- Codex plugin 설정을 실제로 변경하는 `--apply`
- credential 입력
- 실제 법원 login 이후 단계
- 기존 `.haksulsomoim` 데이터 삭제

## 테스트 범위

| 영역 | 확인할 동작 |
| --- | --- |
| Plugin package | build와 Claude/Codex plugin discovery |
| 사건 접수 | 확인 전 미저장, local case card 생성 |
| 증거 | 원본 미복사, path·설명·종류·SHA-256만 저장 |
| 절차 | 형사·민사 독립 상태와 앞으로만 이동하는 전이 |
| 법령 | 국가법령정보센터 공식 출처 |
| Secure Computer | Edge 실행, 공개 페이지 관찰, OCR·masking |
| 보안 경계 | stale observation 거부, 인증·결제·제출 사용자 인계 |
| 종료 | browser·MCP 정리와 session token 무효화 |

## Windows PowerShell runbook

모든 명령은 일반 사용자 PowerShell에서 실행한다. 관리자 PowerShell은 필요하지 않다.

### Gate 0: 도구 확인과 전용 clone

기존 개발 checkout은 사용하지 않는다. build가 `plugin/`을 다시 만들기 때문에
ignored `plugin/node_modules`를 포함한 로컬 자료가 영향을 받을 수 있다. 매 QA마다
전용 disposable clone을 만든다.

먼저 도구의 존재를 확인한다. command-not-found가 나기 전에 누락 목록을 만들어야 한다.

```powershell
$ErrorActionPreference = "Stop"
$RequiredCommands = @("git", "node", "bun", "claude")
$MissingCommands = $RequiredCommands |
  Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }

if ($MissingCommands.Count -gt 0) {
  throw "Missing commands: $($MissingCommands -join ', ')"
}

git --version
node --version
bun --version
claude --version
```

요구사항:

- Git
- Node.js `22.18.0` 이상
- Bun `1.3` 이상
- Claude Code
- Microsoft Edge
- Codex QA도 할 경우 Codex CLI

도구가 없으면 자동 설치하지 말고 이름과 확인 명령을 보고한 뒤 사용자에게 설치
허가를 받는다.

Codex QA 포함 여부를 사용자에게 한 번 확인하고 `YES` 또는 `NO`로 기록한다. `YES`라면
`Get-Command codex`도 확인하고, 없으면 Codex gate만 `BLOCKED`로 기록한다.

```powershell
$CodexScope = (Read-Host "Include Codex QA? YES or NO").Trim().ToUpperInvariant()
if ($CodexScope -notin @("YES", "NO")) {
  throw "Codex scope must be YES or NO"
}

if ($CodexScope -eq "YES" -and -not (Get-Command codex -ErrorAction SilentlyContinue)) {
  Write-Host "Codex is missing: Codex QA will be BLOCKED"
}
```

그다음 전용 clone을 만든다.

```powershell
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$QaWorkspace = Join-Path $env:TEMP "haksulsomoim-windows-qa-$Stamp"

if (Test-Path $QaWorkspace) {
  throw "QA workspace already exists: $QaWorkspace"
}

git clone --branch main --single-branch `
  https://github.com/leetae9yu/haksulsomoim.git `
  $QaWorkspace

Set-Location $QaWorkspace
$Repo = (git rev-parse --show-toplevel).Trim()

git status --short --branch
git branch --show-current
git rev-parse HEAD
```

### Gate 1: QA evidence 디렉터리

evidence는 Git에서 무시되는 `.haksulsomoim` 아래에 둔다.

```powershell
$QaRoot = Join-Path $Repo ".haksulsomoim\qa\windows-$Stamp"
New-Item -ItemType Directory -Force $QaRoot | Out-Null

@"
timestamp: $(Get-Date -Format o)
computer: $env:COMPUTERNAME
windows: $([System.Environment]::OSVersion.VersionString)
commit: $(git rev-parse HEAD)
branch: $(git branch --show-current)
node: $(node --version)
bun: $(bun --version)
claude: $(claude --version)
codexScope: $CodexScope
"@ | Set-Content -Encoding UTF8 (Join-Path $QaRoot "environment.txt")
```

`environment.txt`에 secret이나 사용자 이름을 추가하지 않는다.

### Gate 2: Edge와 secret 확인

Edge 후보를 찾는다.

```powershell
$EdgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$Edge = $EdgeCandidates |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1

if (-not $Edge) {
  throw "Microsoft Edge executable was not found"
}

$env:HAKSUL_BROWSER_EXECUTABLE = $Edge
Write-Host "Edge found:" $Edge
```

법령 QA에는 `LAW_OC`가 필요하다. 값 자체는 출력하지 않는다.

```powershell
if ([string]::IsNullOrWhiteSpace($env:LAW_OC)) {
  $SecureLawOc = Read-Host "LAW_OC, or press Enter to block law QA" -AsSecureString
  $env:LAW_OC = [System.Net.NetworkCredential]::new("", $SecureLawOc).Password
  Remove-Variable SecureLawOc
}

if ([string]::IsNullOrWhiteSpace($env:LAW_OC)) {
  Write-Host "LAW_OC is missing: law QA will be BLOCKED"
}
```

`LAW_OC`가 없더라도 사건 관리와 Secure Computer QA는 계속할 수 있다. 법령 QA만
`BLOCKED`로 기록한다.

두 host agent가 같은 명시적 사건 경로를 사용하게 하고 자동 QA screenshot 경로를
연결한다.

```powershell
$env:HAKSUL_CASES_DIR = Join-Path $Repo ".haksulsomoim\cases"
$env:QA_EVIDENCE_DIR = Join-Path $QaRoot "automated"
New-Item -ItemType Directory -Force $env:QA_EVIDENCE_DIR | Out-Null
```

### Gate 3: build와 자동 검증

각 명령의 stdout, stderr와 exit code를 기록한다. 한 명령이 실패하면 그 실패를
보존하고 원인을 고치기 전까지 다음 gate를 PASS로 처리하지 않는다.

```powershell
function Invoke-QaCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [Parameter(Mandatory = $true)]
    [scriptblock] $Command
  )

  $LogPath = Join-Path $QaRoot "$Name.log"
  & $Command 2>&1 | Tee-Object -FilePath $LogPath
  $ExitCode = $LASTEXITCODE
  "exitCode=$ExitCode" | Add-Content -Encoding UTF8 $LogPath

  if ($ExitCode -ne 0) {
    throw "$Name failed with exit code $ExitCode; see $LogPath"
  }
}

Invoke-QaCommand "01-bun-install" { bun install }
Invoke-QaCommand "02-plugin-validation" { bun run validate:plugin }
Invoke-QaCommand "03-tests" { bun test }
Invoke-QaCommand "04-typecheck" { bun run typecheck }
Invoke-QaCommand "05-lint" { bun run lint }

Invoke-QaCommand "06-mcp" { bun run qa:mcp }
Invoke-QaCommand "07-secure-computer" { bun run qa:secure-computer }
Invoke-QaCommand "08-ocr" { bun run qa:ocr }
Invoke-QaCommand "09-court-mock" { bun run qa:court-mock }

$CourtQaFailure = $null
try {
  Invoke-QaCommand "10-court-live" { bun run qa:court }
} catch {
  $CourtQaFailure = $_
  Write-Warning "Court QA requires classification: $($_.Exception.Message)"
}
```

`LAW_OC`가 있을 때만:

```powershell
Invoke-QaCommand "11-law" { bun run qa:law }
```

기대 결과:

- 모든 명령 exit code `0`
- `bun test`의 fail `0`
- plugin validation `PASS`
- TypeScript와 Biome error `0`
- 실제 법원 QA는 공개 페이지까지만 접근

`validate:plugin`이 내부에서 plugin을 다시 build하므로 별도 `bun run build`는 실행하지
않는다. `qa:ocr`, `qa:court-mock`, `qa:court`가 만든 PNG는
`$QaRoot\automated`에 있어야 한다.

`qa:court`가 실패하면 log를 읽어 제품 결함인지 외부 장애인지 구분한다. DNS, TLS,
portal timeout 또는 외부 HTTP 장애가 명백할 때만 `BLOCKED_EXTERNAL`로 기록하고 이후
local gate를 계속한다. assertion, masking, browser 또는 제품 동작 실패는 `FAIL`이다.

첫 OCR 실행은 language data 준비 때문에 이후 실행보다 오래 걸릴 수 있다. 고정
sleep이나 반복 재실행으로 통과시키지 않는다.

### Gate 4: Claude Code 실제 표면

저장소 루트에서 실행한다.

```powershell
claude --plugin-dir "$Repo\plugin"
```

이미 이 plugin으로 시작한 Claude Code가 실행자라면 중첩 session을 만들지 말고 현재
session에서 아래 절차를 수행한다.

#### MCP discovery

Claude Code에서:

```text
/mcp
```

다음 두 server를 확인한다.

- `plugin:haksulsomoim-small-fraud:haksulsomoim-local`
- `plugin:haksulsomoim-small-fraud:korean-law`

`LAW_OC`가 없으면 `korean-law`만 `BLOCKED`일 수 있다. `haksulsomoim-local`까지
연결되지 않으면 다음 단계로 진행하지 않는다.

#### 사건 접수

```text
/haksulsomoim-small-fraud:small-fraud-agent
```

아래 문장을 그대로 입력한다.

```text
2026-08-01 국내 계좌이체로 5,380,000원을 송금했지만 물건을 받지 못한
합성 소액사기 사건을 정리하고 싶다. 상대방의 합성 연락처는
010-1234-5678이고 합성 계좌는 123-456-789012다. 실제 개인정보는 사용하지 않는다.
```

확인 사항:

1. 짧은 번호형 질문을 한다.
2. 사용자 확인 전에는 사건을 저장하지 않는다.
3. 확인 후 `.haksulsomoim/cases/case-*`를 생성한다.
4. `record.json`, `timeline.md`, `evidence.md`, `criminal.md`, `civil.md`가 생긴다.
5. MCP 응답의 사건 설명과 상대방 표시는 `[MASKED]`로 반환된다.
6. 형사 상태 변경이 민사 상태를 바꾸지 않는다.
7. 이전 단계로 되돌리는 요청을 거부한다.
8. 법령 답변에 공식 출처가 붙는다. `LAW_OC`가 없으면 이 항목만 `BLOCKED`다.

생성 파일은 별도 PowerShell에서 확인할 수 있다.

```powershell
Get-ChildItem -Recurse .haksulsomoim\cases
```

#### 합성 증거

```powershell
New-Item -ItemType Directory -Force .haksulsomoim\cases\incoming | Out-Null

@"
테스트용 거래 내역
송금액: 5,380,000원
송금일: 2026-08-01
이 문서에는 실제 개인정보가 없습니다.
"@ | Set-Content -Encoding UTF8 .haksulsomoim\cases\incoming\test-transfer.txt
```

Claude Code에서:

```text
cases root 기준 incoming/test-transfer.txt를 현재 테스트 사건의 증거로 등록해줘.
```

확인 사항:

- `.haksulsomoim/cases/incoming` 아래의 일반 파일은 정상 등록된다.
- 원본이 사건 폴더로 복사되지 않는다.
- 사건 기록에는 path, 설명, 종류와 SHA-256만 저장된다.
- `..` traversal 또는 `.haksulsomoim/cases` 밖의 파일은 거부한다.
- Windows Developer Mode 등 symbolic link를 만들 수 있는 환경이면 link 원본도
  거부하는지 확인한다. 권한이 없으면 이 항목만 `NOT_RUN`으로 기록한다.

#### Secure Computer

```text
/haksulsomoim-small-fraud:small-fraud-secure-computer
```

아래 문장을 그대로 입력한다.

```text
https://ecfs.scourt.go.kr 공개 페이지를 열어 지급명령 관련 공개 경로를 찾아줘.
로그인, 인증서, 결제, 법적 진술과 최종 제출은 실행하지 말고 그 직전에 멈춰.
```

확인 사항:

1. 별도 Edge window가 열린다.
2. 공개 페이지를 관찰하고 한 번 이상 click 또는 scroll한다.
3. observation에 실제 전화번호나 계좌번호가 그대로 포함되지 않는다.
4. 행동 후 이전 observation digest로 다시 행동하면 거부한다.
5. login, 공동인증서, payment 또는 최종 제출을 요청하면 실행하지 않고 사용자
   인계 메시지를 출력한다.
6. browser session 종료 후 이전 masking token을 재사용할 수 없다.

법원 사이트의 일시적인 network 또는 portal 장애는 제품 PASS로 바꾸지 않는다.
오류 화면, URL, 시각과 message를 기록하고 `BLOCKED_EXTERNAL`로 판정한다.

### Gate 5: Codex 실제 표면

Gate 0에서 Codex를 범위에 넣지 않았다면 이 gate를 `NOT_RUN`으로 기록한다. 범위에
넣었지만 Codex가 없으면 `BLOCKED`다. Codex plugin 설정 변경은 먼저 사용자 허가를
받는다.

먼저 변경 없는 dry run을 확인한다.

```powershell
bun run install:local -- --target=codex
```

출력에 `status: PASS`, `target: codex`, `applied: false`가 있어야 한다.

사용자가 허가하면:

```powershell
$env:HAKSUL_CASES_DIR = Join-Path $Repo ".haksulsomoim\cases"
bun run install:local -- --target=codex --apply
codex plugin list
codex
```

첫 session에서 `/hooks`를 열어 plugin 경로와 다음 명령을 확인한 뒤 사용자가
신뢰해야 한다.

```text
cd "$PLUGIN_ROOT" && npm install --ignore-scripts --omit=dev --no-audit --no-fund
```

그 후 Claude Code gate와 같은 합성 사건, 증거, Secure Computer 시나리오를
실행한다. Codex child process가 상속한 `HAKSUL_CASES_DIR` 때문에 사건 자료는
`$Repo\.haksulsomoim\cases`에 생성되어야 한다. 스킬 이름, MCP tool, local case
file과 보안 경계가 같아야 한다.

## 판정 규칙

| 판정 | 의미 |
| --- | --- |
| `PASS` | 요구 동작을 실제 surface에서 관찰했고 관련 검증이 모두 성공 |
| `FAIL` | 제품 또는 문서의 재현 가능한 결함 |
| `BLOCKED` | dependency, permission 또는 credential 부재로 실행 불가 |
| `BLOCKED_EXTERNAL` | 법원 등 외부 서비스가 응답하지 않아 판정 불가 |
| `NOT_RUN` | 합의된 선택 범위 밖이라 실행하지 않음 |

전체 판정은 필수 gate 중 가장 낮은 판정을 따른다.

- Gate 0~4 중 하나라도 `FAIL`이면 전체 `FAIL`
- Gate 0~4 중 하나라도 미해결 `BLOCKED`이면 전체 `BLOCKED`
- 필수 외부 법원 동작을 판정하지 못한 `BLOCKED_EXTERNAL`은 전체
  `BLOCKED_EXTERNAL`; 제품 PASS로 바꾸지 않음
- Codex가 명시적 범위가 아니면 Gate 5 `NOT_RUN`은 Claude QA의 PASS를 막지 않음
- source review나 자동 test만으로 Gate 4 또는 Gate 5를 `PASS`로 표시할 수 없음

## 증거 보고서

`$QaRoot\REPORT.md`에 다음 양식을 작성한다.

```markdown
# Windows plugin QA report

- Overall: PASS | FAIL | BLOCKED | BLOCKED_EXTERNAL
- Date:
- Windows:
- Commit:
- Host agent:
- Evidence directory:

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Preflight | | |
| Build and automated checks | | |
| Claude MCP discovery | | |
| Claude case intake | | |
| Claude evidence handling | | |
| Claude Secure Computer | | |
| Codex | | |
| Cleanup | | |

## Observed behavior

- Case ID:
- Created files:
- Official-law source:
- Masking result:
- Stale observation result:
- Authentication/payment/submission handoff:

## Failures or blockers

- Exact command or action:
- Exit code:
- Error text:
- Screenshot:
- Reproduction:

## Safety confirmation

- [ ] No real PII used
- [ ] LAW_OC not logged
- [ ] No login, payment, legal attestation or final submission performed
- [ ] No evidence committed to Git
- [ ] Processes started by this QA were closed
```

Screenshot에는 secret과 실제 개인정보가 없어야 한다. 사용자에게 전달할 때는
`REPORT.md`와 필요한 screenshot만 Windows의 `Oracle Shared` 폴더로 복사한다.

## 종료와 정리

Claude/Codex와 자신이 연 Edge session을 정상 종료한다. 그 후:

```powershell
Remove-Item Env:LAW_OC -ErrorAction SilentlyContinue
Remove-Item Env:HAKSUL_BROWSER_EXECUTABLE -ErrorAction SilentlyContinue
Remove-Item Env:HAKSUL_CASES_DIR -ErrorAction SilentlyContinue
Remove-Item Env:QA_EVIDENCE_DIR -ErrorAction SilentlyContinue
Get-Process node, msedge -ErrorAction SilentlyContinue
git status --short --branch
```

기존 Node와 Edge process를 무조건 종료하지 않는다. QA가 시작한 PID가 남았을 때만
해당 process를 종료하고 그 사실을 보고서에 적는다.

전용 `$QaWorkspace`에는 QA report와 합성 사건이 남는다. 보고서를 전달하기 전에는
workspace를 삭제하지 않는다. 전달 후 삭제하려면 실제 자료가 없음을 확인하고 사용자
허가를 받은 뒤 PowerShell에서 workspace 밖으로 이동해:

```powershell
Set-Location $env:TEMP
Remove-Item -Recurse -Force $QaWorkspace
```

## 자주 발생하는 문제

| 증상 | 확인 |
| --- | --- |
| `haksulsomoim-local` disconnected | `bun run build`, Node version, plugin 절대 경로 |
| `korean-law`만 disconnected | 현재 PowerShell의 `LAW_OC` 존재 여부 |
| Edge를 찾지 못함 | Gate 2 후보 경로와 `HAKSUL_BROWSER_EXECUTABLE` |
| 첫 OCR이 느림 | language data 초기 준비 여부; 고정 sleep으로 우회하지 않음 |
| court page 접근 실패 | URL, 시각, network 오류를 기록하고 `BLOCKED_EXTERNAL` |
| Codex MCP가 시작되지 않음 | `/hooks`의 경로와 install command 신뢰 여부 |
| case file이 예상 위치에 없음 | 실행 위치와 `HAKSUL_CASES_DIR` |
| 종료 후 process가 남음 | 자신이 시작한 PID인지 확인한 후에만 종료 |

실패 보고에는 host agent, Windows version, commit, 실패 gate, 정확한 오류, 생성된 합성
case ID만 포함한다. 실제 개인정보나 `LAW_OC` 값은 공유하지 않는다.
