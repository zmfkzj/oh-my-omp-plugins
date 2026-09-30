# om-orche 자체 오케스트레이션 구현 계획

작성: 2026-09-27
정책 개정: 2026-09-28 — 사용자 요청에 따라 리뷰 게이트를 일괄 제거하고 Orche-Advisor를 수립된 계획에 대한 조언 도구로 전환한다.
정책 개정: 2026-09-29 — Jev 기반 DEFAULT/ORCHESTRATE 라우팅과 todo 기반 승격은 같은 날 하나의 정책 안내(notice)로 대체됐다. 이 안내는 판단형(Judgment)과 제작형(Production) 두 실행 정책과 단계별 선택 규칙을 담고, 선택은 메인 모델이 현재 단계마다 한다. 아래 본문의 Jev 라우팅·todo 승격·confidence/margin 게이트 서술은 당시의 기록이며 현재 정책이 아니다. 현재 동작은 `README.md`를 따른다.
상태: 플러그인 이름을 `om-orche`로 변경하고 OMP 18.3.5에 맞춰 의존성·peer dependency를 고정했다. 타입/테스트 및 로컬 모델 서버를 사용하는 18.3.5 native 실행 검증 완료. 상용 모델의 판단 품질과 모든 호스트 설정 조합 검증은 포함하지 않는다.

## 1. 목표와 확정 결정

목표는 필요한 위임만 수행하고 실제 산출물과 검증까지 책임지는 조정 계층이다. 모델의 동의를 실행 권한으로 취급하지 않는다.

1. 일반 구현 워커는 OMP의 native `task`를 사용한다. 모델 선택은 OMP의 `@task`에 맡기며 주 모델을 바꾸지 않는다.
2. Jev는 DEFAULT/ORCHESTRATE 실행 방식만 선택한다. 리뷰 위험도와 승인용 작업 scope 연결 질문은 제거한다.
3. 플러그인 소유 실행 지침을 유지한다. task 도구·워커 런타임·호스트 검증을 복제하거나 task 인자를 재작성하지 않는다.
4. `ReviewGate`, 실행 승인 상태, receipt, dispatch staging/withdrawal, spawn permit, eval/workpool 승인 fingerprint를 모두 제거한다.
5. `/review-status`, `/review-retry`, `/review-waive` 명령을 제거한다. DEFAULT의 다중 워커 배치에도 별도 리뷰 승인을 요구하지 않는다.
6. `orche_advisor`는 계획 수립이 끝나면 실행·위임 전에 한 번 호출한다. `KEEP`, `ADJUST`, `REPLAN`, `ESCALATE` 모두 조언이며 도구·워커 실행을 허용하거나 차단하지 않는다.
7. 리뷰어 부재·장애·잘못된 응답은 조언을 얻지 못한 오류이지 실행 금지가 아니다. 조정자가 판단하고 인수 조건을 검증한다.
8. Verification Auditor와 finding ledger는 근거와 의견을 보존한다. finding 생성·변경·해결이 도구 실행이나 단계 진행을 차단하거나 재리뷰를 강제하지 않는다.
9. OMP native 입력 검증, agent/tool 권한, 동시성, 취소, 지원되는 격리 정책은 그대로 둔다. 이는 검토한 계획과 실제 dispatch 일치를 보장하는 별도 승인 기능을 대신하는 것은 아니다.
10. 전문/custom agent, 사용자 모델 역할, telemetry 이력을 보존한다. 명시적으로 요청하지 않은 commit, push, PR, 배포는 하지 않는다.

**이 결정은 이전 계획의 “기존 리뷰 게이트와 승인 보호 유지” 조항을 대체한다.** 과거 승인 보존 요구를 이번 삭제의 차단 조건으로 사용하지 않는다. 아래 과거 검증 기록은 새 정책의 요구사항이 아니다.

별도 task 입력 필드를 만들지 않는 기존 사용자 선택은 유지한다. 당시 실제 선택은 **“기존 task 본문 사용”**이었으며, 목표·수정 범위·확정/미확정 결정·인수 조건을 task 본문으로 전달한다. 별도 solutionSpace 필드 구현이 성공했다는 뜻이 아니다.

## 2. 목표 실행 흐름

```text
사용자 요청
  → Jev: DEFAULT / ORCHESTRATE
  → 플러그인 소유 실행 지침
  → 조정자가 범위 조사와 계획 수립
  → 계획 수립이 끝나면 실행·위임 전에 orche_advisor를 한 번 호출 (verdict는 조언)
  → 조정자가 조언을 평가하고 OMP native task 또는 직접 실행
  → 실제 산출물·테스트·인수 조건 검증
  → 완료 또는 실제 환경/기술적 차단 보고
```

- 새로운 대화 턴, todo 완료, 워커 완료, 감사 finding만으로 조언 모델을 호출하지 않는다.
- 변경 없는 계획에 대한 반복 호출, 리뷰어의 범위 밖 요구 자동 실행, 자동 모델 승격을 하지 않는다.
- Jev 자격증명 부재나 분류 실패가 native task 또는 직접 실행을 막지 않는다.
- 성공한 todo init/append의 새로운 계획은 실행 경로를 재고할 수 있다. 일반 상태 변경과 단계 완료는 리뷰 이벤트를 만들지 않는다.

## 3. 실행 지침과 task 본문 계약

- DEFAULT는 직접 작업과 필요한 단일 위임을 위한 가벼운 지침이다.
- ORCHESTRATE는 실제 독립성과 문맥 분리 이점이 있는 작업의 조정 지침이다. 필수 워커 수를 정하지 않는다.
- 실행 지침 우선순위는 현재 턴 workflow > 명시적 orchestrate > 자동 ORCHESTRATE > DEFAULT다.
- workflow는 호스트 실행 방식을 유지하고 플러그인은 계약·검증 보조만 제공한다.
- native orchestrate notice는 현재 턴에 한해 자체 notice로 교체한다. 사용자 원문·과거 메시지·다른 확장은 변경하지 않는다.
- 실행 정책은 `orchestration-policy.ts`, 선택적 조언 안내 합성은 `orche-advisor.ts`의 context hook이 각각 소유한다.
- master disable은 자동 분류와 안내를 끄며, 수동 조언·finding 도구는 유지한다.

task 본문에는 목표, 수정 범위와 비목표, 확정/미해결 결정, 입력·의존성, 인수 조건과 검증 책임, 반환할 결과를 적는다. 여러 항목의 shared context에는 공통 목표·비목표·제약·확정 결정·공유 인터페이스를 한 번 적고, 각 항목에는 자기 단위의 목표·쓰기 범위·열린 판단·입력·인수 조건·반환을 담는다. shared context와 항목을 합쳐 완전한 계약이어야 한다. 이는 지침이지 플러그인의 별도 검증 스키마가 아니다.

위임 전에 각 단위의 쓰기 범위(파일·모듈·자산), 제공·소비 인터페이스, 선행 조건, 인수 검사를 적는다. 쓰기 범위가 겹치지 않고 인터페이스가 확정됐으며 별도 인수가 가능한 독립 단위는 준비된 것을 한 dispatch에서 함께 시작한다. 쓰기 범위·미확정 공유 결정·단일 인수 검사를 공유하면 응집된 한 단위로 한 워커가 끝까지 맡는다. 생산자·소비자가 인터페이스만 공유하면 이름·형태·오류·소유자를 먼저 확정하고 양쪽을 함께 시작한다. 파일 수나 분량이 아니라 독립 인수와 문맥 격리로 나누며, 실제 의존성·소유권·자원 충돌만 순서를 만든다. 독립 단위를 묶거나 직렬화하면 계획에 이유를 적는다. 판단형의 독립 미지 영역·가설도 병렬로 한정 조사하되 최종 판단은 메인이 맡는다.

의존 작업은 선행 계약이 확인된 뒤 실행한다. 독립적인 후속 작업을 unrelated worker 때문에 기다리게 하지 않는다. 공유 checkout의 전역 테스트·포매터는 동시에 실행하지 않는다. 워커 자기보고와 인수 성공을 구분한다.

`solutionSpace` 별도 필드, task wrapper, 별칭, 자체 DAG/큐/잠금 서비스, 호스트 fork는 도입하지 않는다. 전문 에이전트의 정체성과 native 기본 agent 선택을 변경하지 않는다.

## 4. Orche-Advisor 조언 계약

- 입력은 기존 `checkpoint`와 7개 문자열 snapshot이다: goal, currentPlan, completedWork, agents, failuresOrBlockers, tokenOrContextConcerns, nextProposedActions.
- checkpoint는 조언의 맥락을 표시한다. 계획 수립 종료 후 실행·위임 전 한 번 호출하되 verdict는 조언이고 실행 승인 게이트가 아니다.
- `dispatch` 인자는 삭제한다. 작업 위임은 native task에 직접 제출하며 사전 승인·withdrawal이 없다.
- primary-only 호출, 명시적 `modelRoles.orche-advisor`, 동시 중복 호출 제한, 입력/출력 크기 제한, 모델 사용량 기록은 유지한다.
- 각 명시적 호출은 새로운 모델 요청이다. 이전 receipt·scope·finding hash에 의존하는 승인/응답 재사용은 제거한다.
- 유효한 네 verdict는 정상 결과이며 CLI exit 0이다. 실제 모델/출력 오류는 exit 1, 입력/설정 오류는 exit 2다.
- 중요한 수정 의견은 조정자가 채택·부분 채택·기각 여부와 이유를 간단히 설명한다. 채택한 내용은 실행 전에 확정 계획/todo와 관련 워커 지시에 반영하며, 재승인 없이 진행한다. advisor가 계획을 자동 변경하지 않는다.
- 필수 계획 수립 종료 호출 이후, 변경된 계획이나 새 근거에 대한 추가 조언은 선택 사항이다. REPLAN을 이유로 자동 재호출하거나 KEEP을 받을 때까지 반복하지 않는다.
- 미해결 finding과 완료 주장의 모순은 여전히 ID와 근거로 지적하고 최소 수정·검증을 권고한다. 이를 도구 중단 명령으로 만들지 않으며, 계획 수정이나 조언 수신만으로 finding을 해결하거나 완료 증거를 대체하지 않는다.
- provider 오류와 truncation의 기존 제한된 복구는 유지하며 취소는 재시도하지 않는다. 리뷰어 장애를 복구할 때까지 도구 실행을 멈추게 하지 않는다.
- findings와 인용된 근거는 조언의 입력이다. 감사자가 주장한 사용자 지시를 실제 사용자 지시로 대체하지 않는다.
- 과거 gate denial, receipt, waiver나 이를 요구하는 감사 문구는 현재 권한 조건이 아니다.

## 5. 삭제·보존과 재개 세션

삭제:
- `src/review-gate.ts`, 승인 전용 `src/task-contract.ts`, 해당 gate/permit/dispatch 테스트.
- runtime의 gate 인스턴스·review callback, tool_call·before_subagent_spawn 승인 hook, 승인용 session cleanup hook.
- Jev review/work-scope 질문, required 상태·phase review trigger·승인 판단 UI 및 새 telemetry 행의 review 필드.
- advisor executionScope·scopeKey·receipt·stale approval 처리, review_rejected 오류 유형, 승인 명령/프롬프트.
- finding revision 승인 digest. finding 자체의 안정된 ID·근거·상태는 유지한다.

보존:
- OMP native 도구와 spawn 정책, 모델 역할, 비동기 결과·취소·usage 관측.
- DEFAULT/ORCHESTRATE 분류, 새 todo 계획의 승격, provider-context notice 순서와 턴 소유 판별.
- 수동 계획 조언, passive auditor, evidence-bound finding lifecycle.
- 기존 credential와 telemetry 원본, tier 이력 및 migration/reset 동작. 백업·rollback 규칙은 README의 Telemetry 절을 따른다.

업그레이드 전 진행 중 작업을 종료하거나 취소하고 새 세션에서 확장을 로드한다. 예전 플러그인의 hook이 남아 있는 실행 중 세션을 무승인 shim으로 바꾸지 않는다.

과거 승인·거절·waiver custom entries와 telemetry 행은 파괴적으로 지우지 않지만 새 제품은 실행 권한에 사용하지 않는다. 새 승인을 받을 필요도 없다. finding의 `waive`는 사용자의 위험 수용을 기록하는 기능이며 삭제된 `/review-waive`와 다르다.

## 6. 구현 단위와 검증 조건

| 단위 | 범위 | 조건 |
| --- | --- | --- |
| G1 실행 게이트 삭제 | index/runtime/review-gate/task-contract | mutation·native task·eval/workpool에 플러그인 승인 차단 없음 |
| G2 전면 분류 정리 | jev/orchestration/routing-context/policy/commands | route만 질문하고 승인 상태·risk/scope·phase review 제거 |
| G3 advisor 분리 | orche-advisor/advisor-review/advisor-cli | 실제 조언과 provider 오류는 유지하되 verdict가 권한으로 작동하지 않음 |
| G4 문서/이력 정합성 | README/본 계획/metadata/examples/findings | 이전 정책과 신규 정책 구분, 과거 데이터 비파괴 |
| G5 인수 검증 | 실제 hooks/tests/CLI/native host | 아래 N1–N6을 검증하고 실행 범위를 보고 |

| 기준 | 관찰할 결과 |
| --- | --- |
| N1 | DEFAULT/ORCHESTRATE, 과거 승인·실패 기록, 새 finding 유무와 무관하게 플러그인이 tool/spawn을 차단하지 않음 |
| N2 | KEEP/ADJUST/REPLAN/ESCALATE가 조언으로 반환되고 반복 명시 호출도 승인 상태에 막히지 않음 |
| N3 | 실제 모델/출력 오류는 isError로 보고되지만 다음 도구 호출에 권한 상태를 남기지 않음 |
| N4 | Jev 요청에 route 질문만 포함되고 모델·notice·승격의 기존 비승인 동작 유지 |
| N5 | native task가 reviewer 호출 없이 실제 워커를 실행하고 워커가 산출물을 생성 |
| N6 | 승인 전용 참조/스키마/명령/문서가 제거되고 과거 기록이 현재 권한으로 해석되지 않음 |

## 7. 이번 정책 변경 검증 결과om-orcheom-orche

- `bun run build`om-orche 통과, lint 오류 0(기존 no-control-regex 경고 2건), 14개 테스트 파일에서 133 pass / 0 fail.
- 이름/버전 변경 후 OMP 18.3.5에서 `bun run build`를 실행해 동일한 133개 테스트가 통과했다. 실제 plugin manager에서 `om-oche` 링크와 새 이름의 설정 저장·조회, `/om-oche status`의 모델 호출 없는 처리를 확인했다. 명령의 UI 알림은 print 모드 출력에 노출되지 않는다.
- OMP 18.3.5 native smoke에서도 일반 요청과 명시적 orchestrate 요청 각각 두 워커가 예상 파일을 작성했다. 로컬 결정적 모델 서버, 임시 workspace/HOME/agent-dir, native `--auto-approve`를 사용했으며 임시 상태는 제거했다.
- 공개 패키지·설정·명령은 `om-oche`로 전환하고 이전 이름의 별칭은 두지 않는다. 기존 telemetry 디렉터리 `jev-router`는 데이터 보존을 위해 유지한다. 사용자 전역 설정·기존 설치본을 자동 변경하지 않는다.
- 실제 `orche-advisor` CLI + 격리된 agent 디렉터리 + 로컬 OpenAI-compatible 서버: KEEP, REPLAN, ESCALATE 각각 exit 0 / isError false / completion 1회. 승인 metadata가 반환되지 않음을 확인했다.
- 고정 dependency OMP 18.3.1 CLI에 현재 확장을 명시적으로 로드했다. 일반 요청과 명시적 orchestrate 요청에서 native task 배치가 각각 두 워커를 실행했고, 워커의 write 도구가 총 4개의 예상 파일을 만들었다. 주 에이전트가 파일을 대신 쓰지 않았다.
- 이 native smoke는 임시 workspace·HOME·agent-dir·모델 설정을 사용하고 native 도구 승인만 `--auto-approve`했다. 플러그인 리뷰 호출/waiver/receipt는 없었다. 임시 상태와 출력 파일은 제거했다.
- 모델 응답은 결정적인 로컬 서버로 공급했다. 상용 모델의 판단 품질, 모든 provider/설정 조합, OMP 18.3.4에서의 이번 cutover, 실제 사용자 설치본 reload/uninstall은 검증했다고 주장하지 않는다.
- 과거 gate 테스트는 삭제하고 조언 전용 및 비차단 동작을 검사하는 테스트로 전환했다. 이전 테스트 개수와 단순 비교해 검증 품질을 주장하지 않는다.

## 8. 이전 게이트 포함 릴리스의 검증 기록 (역사)

아래는 2026-09-27의 **이전 정책** 실행 기록이다. 여기 나오는 리뷰 승인·permit·A1–A21은 이번 정책의 요구사항이나 현재 검증 결과가 아니다. 원본 실행 증거를 새 동작의 증거로 재해석하지 않기 위해 기록을 남긴다.

당시 검증일: 2026-09-27. tier classifier/alias/generator를 제거하고 task-contract, 자체 정책, 리뷰/permit, telemetry v5를 통합했던 릴리스의 기록이다.

### 자동 검증

- `bun run check`: 통과.
- `bun run lint`: 오류 0, 기존 `no-control-regex` 경고 2건(`src/advisor-review.ts`, `test/review-output.test.ts`).
- `bun test`: 16개 파일, 198 pass / 0 fail, 939 assertions.
- 통합 중 발견한 readonly fixture 타입 오류와 초기 risk assessment/실행 gate의 시점이 다른 테스트를 수정했다.
- 실제 master-disable smoke에서 Advisor 지침이 native notice에 붙는 결함을 발견해 수정하고 회귀 테스트 및 두 버전 재실행으로 확인했다. 수동 reviewer 도구는 유지하면서 자동 안내 합성만 master switch를 따른다.

### 실제 호스트 검증

- 18.3.1: 저장소 dependency의 `dist/cli.js`를 실행.
- 18.3.4: 시스템 `omp` 실행.
- 임시 작업공간과 프로세스 전용 config overlay 사용. `@task`는 이 smoke에서만 `anthropic/claude-opus-5-5`에 연결했다. 사용자 전역 역할·plugin 설정은 변경하지 않았고 telemetry persistence는 project override로 비활성화했다.
- 각 버전의 실제 task 도구 → 검증·gate → bundled `task`, `modelRole: task` → started/completed 이벤트 → 워커 작성 파일을 관찰했다. 본문의 덧셈 결정에 따라 입력 19,23에서 `{"result":42,"contract":"native-task-body"}`가 생성됐다.
- native `orchestrate` 요청의 reviewed batch에서 첫 워커를 잠시 지연하고 `write proc://QueueRetryC<version>/kill`로 대기 중인 두 번째 작업을 실제 취소했다. owner snapshot에 원래 job의 `cancelled`가 기록됐고, 그 원래 ID의 spawn은 없었다. 같은 native 이름의 재제출은 `QueueRetryC<version>-2`로 실행·완료됐다. 부모가 결과 파일을 대신 작성하지 않았다.
- 최초 자동 취소 관찰 확장은 실제 취소를 만들지 못했다. 그 실행은 취소 성공 근거에서 제외하고 위 native kill 시나리오로 교체했다.
- `workflowz orchestrate`는 두 버전에서 native workflow notice + 자체 보조 notice를 유지하고 Advisor 안내는 한 번만 붙었다.
- master disabled는 두 버전에서 원래 native `orchestrate-notice`만 남고 plugin Advisor 안내가 붙지 않았다.
- 실제 18.3.1 worker progress/lifecycle 기록을 별도 telemetry 인스턴스에 두 번 재생했다. 시작/완료/usage 표본은 각각 1회, unknown 0이며 원래 관찰된 토큰·비용과 일치했다.

### 수용 기준별 증거와 범위

| 기준 | 확인한 증거 | 범위/제한 |
| --- | --- | --- |
| A1 | 두 버전 실제 bundled task/@task 실행, tier API 제거 | smoke 모델 고정; 모든 provider를 시험한 것은 아님 |
| A2 | native schema default 변경과 명시 agent 우선순위 자동 검증 | restricted 부모 전체를 live로 실행한 것은 아님 |
| A3 | native 입력·agent 보존, specialist read-only gate 자동 검증 | 사용자 custom agent별 live 실행은 미실행 |
| A4 | 자동 routing의 model 불변·정책 선택 자동 검증 | ORCHESTRATE 선택률/정확도 비교 아님 |
| A5 | 자동/명시/replay 통합 테스트 + 두 버전 explicit native context 관찰 | 과거 턴 불변은 자동 검증 |
| A6 | 개별 master/auto/keyword/task/plan-mode 자동 검증 + master off live 확인 | 모든 설정 조합의 live 전수검사는 아님 |
| A7 | 실제 reviewer 승인 → 두 버전 batch 실행, 계약 hash 자동 검증 | 지연된 별도 계약은 새 리뷰를 받음 |
| A8 | task/context/nested schema `i` 등 의미 변경의 승인 무효화 자동 검증 | 공격적 입력 전체에 대한 보안 감사 아님 |
| A9 | 과거 receipt/withdrawal/branch/finding revision 자동 검증 | 이전 승인을 재사용하지 않음 |
| A10 | eval worker fingerprint gate 자동 검증 | 실제 workpool 모델 실행은 별도 미실행 |
| A11 | 두 버전 async 완료·대기 취소·재제출 + failure/aborted 자동 검증 | 진행 중 provider 중단의 모든 타이밍은 미측정 |
| A12 | 두 버전 실제 워커의 본문 결정 준수와 결과 파일 | 별도 solutionSpace API 성공 주장이 아님 |
| A13 | native schema shape·default·거부 경계 자동 검증, live batch sync/async | isolation/effort/eval-tools의 live 전체 조합은 미실행 |
| A14 | migration·재실행·rollback/재업그레이드 임시 파일 테스트 | 사용자 실제 telemetry를 migration하지 않음 |
| A15 | 두 버전 실제 모델·호스트 경유, scope 리뷰·spawn·산출물 확인 | JSON payload를 라우터에 직접 넣는 smoke와 구분 |
| A16 | 두 버전 master off native 안내 복원, 전역 역할 불변 자동 검증 | 사용자 global uninstall 명령은 실행하지 않음 |
| A17 | 실제 host validator parity와 invalid-input/default/flat/batch 자동 검증 | host schema 밖 필드 처리는 버전과 shape에 따라 다름 |
| A18 | 두 버전 실제 workflowz+orchestrate 관찰 및 조합 자동 검증 | workflow 자체의 실행 효율 검증은 아님 |
| A19 | permit 수명/중복/모호성/same-scope 취소 자동 검증 + live queued kill/이름 재사용 | 실제 재제출은 변경 계약 재리뷰를 포함; same-scope pruning은 자동 검증 |
| A20 | 실제 이벤트 중복 재생 + missing/late usage 및 aborted 자동 검증 | task tool/eval 호출 경로는 구분 불가로 표시 |
| A21 | 백업 실패·미래 버전·reset/load 경쟁·재시작 자동 검증 | 다중 프로세스 동시 migration/쓰기의 lock 서비스는 비목표 |

재현 흔적은 이 작업 세션의 `local://self-orchestration-smoke-evidence.json`과 도구 출력에 보존했다. 임시 smoke 확장·설정·산출물은 검증 후 제거하며 영구 제품 기능이나 테스트 suite에 섞지 않는다.

비용/품질의 전후 비교, 모든 provider·host 설정 조합의 인증, 사용자 설치본의 실제 업그레이드/제거는 이번 결과로 주장하지 않는다. OMP 자체 분석과 task 티어 비교는 구현에 반영됐지만, 과거의 부정확한 완료 보고에 대한 finding은 별도 상태 관리 대상이다.
