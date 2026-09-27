# 자체 오케스트레이션 구현 계획

작성: 2026-09-27
상태: 제품 코드 반영 및 통합 검증 완료. 자동 검증과 OMP 18.3.1/18.3.4의 실제 native smoke 범위·제한은 15절에 기록한다. 과거 별도 필드 지원 또는 모든 기존 finding의 해소를 뜻하지 않는다.

## 1. 목표와 확정 결정

목표는 더 많은 에이전트가 아니라, 필요한 위임만 수행하고 검증된 결과까지 책임지는 조정 계층이다.

1. 일반 구현 워커는 OMP의 `task` 하나를 사용한다. 모델 선택은 OMP의 `@task` 역할에 맡긴다. 주 모델은 변경하지 않는다.
2. `task-easy`, `task-hard`, `task-challenge` 별칭 및 작업별 Jev 티어 분류를 제거한다. 실패 후 숨은 모델 승격도 넣지 않는다.
3. 자체 오케스트레이션 지침은 플러그인이 소유한다. OMP 원본 `orchestrate` 프롬프트를 실행 정책으로 재사용하지 않는다.
4. OMP의 task 실행, spawn 정책, 동시성, 비동기 결과, 취소, 도구 권한, 격리, workpool은 재사용한다.
5. 별도 task 도구, 같은 이름의 wrapper, 별도 워커 런타임은 만들지 않는다.
6. `solutionSpace`의 의미는 기존 `task` 본문에 포함한다. 별도 JSON 필드 지원은 이번 목표에서 제외한다.
7. Jev의 DEFAULT/ORCHESTRATE 및 리뷰 필요성 판단은 유지한다. 작업마다 모델을 고르는 역할만 제거한다.
8. 기존 리뷰 게이트·사용자 waiver·finding 상태는 유지한다. 정책 변경을 이유로 승인 보호를 약화하지 않는다.
9. 전문 조사·검토 에이전트와 사용자가 지정한 custom agent는 유지한다. `task` 단일화는 모든 역할을 하나로 합치거나 워커 수를 1로 제한한다는 뜻이 아니다.
10. 명시적으로 요청하지 않은 commit, push, PR 생성, 배포는 수행하지 않는다.

### 입력 계약 변경의 사용자 근거

이번 계획 수립 중 선택 질문에 대한 사용자의 실제 선택은 **“기존 task 본문 사용”**이다.
선택지 설명: “별도 solutionSpace 필드 요구를 철회하고, 목표·수정 범위·확정/미확정 결정·인수 조건을 task 본문의 표준 양식으로 전달합니다. OMP 스키마와 실행 도구를 변경하지 않습니다.”

이는 기존 별도 필드 구현이 성공했다는 뜻이 아니다. 기존 구현은 호스트 검증 이후 전달만 지원하여 end-to-end로 동작하지 않았다. 이번 계획은 사용자 선택에 따라 그 API를 만들지 않고 기존 지원 필드로 의미를 전달하는 설계 변경이다. 기존 검증 지적을 자동으로 닫지 않는다.

## 2. 비목표

- OMP 본체 또는 node_modules 수정, 별도 호스트 fork.
- Compound Engineering, Superpowers, GSD 전체 설치 또는 실행 파이프라인 중첩.
- 자체 DAG 실행 엔진, 작업 큐, 재시도 서비스, 파일 잠금 체계, 세션 DB.
- 평가 모델의 동의만으로 완료 인정.
- 필수 워커 수, 모든 작업의 재위임, 모든 작업별 독립 리뷰.
- 별도 solutionSpace/schema 필드, native task schema 복제, 임의 도구 실행 브리지.
- 티어 단일화가 더 싸거나 정확하다는 미측정 성능 주장.

## 3. 구현 전 코드에서 확인한 출발점

| 구현 전 위치 | 당시 사실 | 변경 방향 |
| --- | --- | --- |
| `src/index.ts` | 세 역할을 초기화하고 tier alias를 조사하며 task 호출을 재작성 | reviewer/auditor 역할만 유지, task 재작성 제거 |
| `src/orchestration.ts` | OMP `renderOrchestrateNotice`를 가져오고 자동 판단도 native keyword 설정에 의존 | 자체 정책 렌더러, 자동/명시적 요청 경로 분리 |
| `src/task-routing.ts` | 티어 분류 외에 `normalizeCall`도 소유 | 분류 제거, 리뷰에 필요한 입력 정규화만 별도 모듈로 이동 |
| `src/review-gate.ts` | 정규화 import, 별칭을 task로 치환, 정확한 dispatch hash 및 spawn permit 사용 | 정상 native agent 계약으로 전환, 정책 버전 변경 시 과거 승인 무효화 |
| `src/jev.ts` | 전면 분류와 task 티어 분류가 한 엔진에 존재 | 전면 분류와 리뷰 판단만 유지 |
| `src/deep-agent.ts`, `agents/task-*.md` | bundled task를 복제하여 모델 역할만 변경 | 플러그인 소유 세 별칭과 생성 코드 제거 |
| `src/telemetry.ts`, `src/worker-usage.ts` | 티어 선택과 워커 사용량이 별도 경로 | 티어 이력은 보존하고 실제 native task 사용량 중심으로 표시 |
| `src/commands.ts` | 상태·진단에 티어/별칭/샘플 분류 노출 | 자체 정책 상태, native task 역할, 리뷰·워커 사용량 표시 |

OMP 18.3.1에서 native orchestrate는 턴별 지침이며 별도 스케줄러가 아니다. workpool은 작업 큐이지 의존성 DAG가 아니다. 기존 task의 스키마·기본 agent·도구 가용성은 세션 정책에 따라 동적이므로 플러그인이 대체하지 않는다.

버전 증거를 분리한다. 초기 소스 분석은 저장소 의존성 18.3.1 기준이고 시스템 `omp` CLI는 18.3.4였다. 구현 뒤 두 버전으로 각각 native task 실행·취소·지침 표면을 확인했다(15절). 모든 호스트 기능의 포괄적 호환성 인증은 아니며, 고정 의존성 18.3.1을 자동 업그레이드하지 않는다.

## 4. 목표 실행 흐름

```text
사용자 요청
  → 기존 전면 판단: 실행 방식 + 리뷰 필요성 + 작업 scope
  → 플러그인 소유 지침
  → 주 에이전트가 범위 조사와 계획 수립
  → 필요한 경우에만 기존 task 도구 호출
  → 기존 리뷰 게이트: 제출 계약과 승인 일치 확인
  → OMP native preflight / spawn / 실행 / 취소
  → 워커 결과 제출
  → 주 에이전트가 통합과 인수 조건 검증
  → 완료 또는 근거가 있는 차단 보고
```

어느 단계에서도 `agent: task`를 별칭으로 바꾸지 않는다. task 실행 자체는 Jev task 분류용 자격증명/네트워크에 의존하지 않는다. 단, 유지되는 전면 리뷰 판단의 실패는 기존 보수적 리뷰 정책을 따른다. 이를 “플러그인 전체가 오프라인 동작한다”로 표현하지 않는다.

## 5. 자체 정책의 구체적 규칙

### 5.1 실행 방식 선택

- **직접 실행:** 응집된 작업, 순차 의존성이 큰 작업, 위임 준비가 실제 작업보다 큰 경우.
- **단일 위임:** 분리된 문맥이나 도구 범위가 유용한 충분한 작업 단위. 억지로 두 번째 작업을 만들지 않는다.
- **병렬 위임:** 서로의 미완성 산출물 없이 실행 가능하고, 변경 소유권·인터페이스·런타임 자원이 충돌하지 않는 작업.
- 파일 수나 프롬프트 길이는 독립성의 증거가 아니다. 의존하는 작업은 선행 계약이 확인된 뒤 제출한다.
- 제한은 OMP concurrency/spawn 정책을 사용한다. 별도 고정 워커 수를 도입하지 않는다.
- 독립적인 후속 작업은 관련 선행 작업이 검증되면 시작할 수 있다. unrelated worker까지 기다리는 전역 barrier를 강제하지 않는다.

### 5.2 기존 task 본문 계약

새 필드는 추가하지 않는다. 모델이 다음 내용을 task 문자열로 작성하도록 안내한다.

```text
# 목표
관찰 가능한 산출물
# 범위와 비목표
수정 소유권, 관련 인터페이스, 건드리지 않을 영역
# 확정된 결정과 미해결 판단
이미 정해진 해법 / 워커가 판단해야 하는 문제
# 입력과 의존성
참조 파일·산출물, 검증된 선행 계약
# 인수 조건과 검증 책임
성공·오류·경계 동작, 워커 국소 검증, 조정자 통합 검증
# 반환
완료/차단 상태, 실제 변경, 실행한 검증과 결과, 남은 문제
```

- shared `context`는 공통 제약에만 사용한다. 전체 대화/이전 보고를 반복 복사하지 않는다.
- 구조화 결과는 필요한 경우에만 OMP 기존 `outputSchema`를 사용한다.
- 위 양식은 지침이지 별도 런타임 필수 스키마가 아니다. 기존 자유 형식 task 호출을 파싱 실패로 차단하지 않는다.
- `solutionSpace`라는 독립 필드를 모델에 광고하지 않는다. eval/workpool도 같은 의미를 지원되는 task/context에 넣는다.
- 확정된 사용자 선택을 워커가 임의로 재설계하지 않는다. 결함이 드러나면 근거와 함께 반환한다.

### 5.3 검증과 실패 처리

- 워커의 종료/자기보고와 요구사항 충족을 구별한다.
- 공유 checkout에서 전역 테스트·포매터는 동시에 돌리지 않는다.
- 격리되거나 충돌 없는 국소 smoke는 워커가 수행할 수 있다. 통합과 최종 인수는 주 에이전트 책임이다.
- 오류 원인을 먼저 구분한다: 구현 결함, 계약 모호성, 환경/권한 부재, 통합 충돌, 미해결 설계.
- 작은 명백한 수정은 조정자가 직접 처리할 수 있다. 모든 수정에 새 워커를 만들지 않는다.
- 같은 실패를 입력/가설 변화 없이 반복하지 않는다. 실행 가능한 다음 단계가 없으면 정확한 blocker를 보고한다.
- 자동 모델 승격, 무한 reviewer loop, reviewer의 범위 밖 요구를 자동 실행하지 않는다.
- review/finding 정책의 기존 강제 조건은 유지한다. 프로세스 단순화가 승인 우회가 되지 않게 한다.

## 6. 지침 활성화와 native notice 우선순위

새 파일 `src/orchestration-policy.ts`가 도구 가용성에 맞는 짧은 공통 실행 지침과 ORCHESTRATE 지침을 렌더링한다. 외부 프레임워크 의존성은 추가하지 않는다.

| 조건 | 정책 |
| --- | --- |
| `enabled=false` | 자체 지침·재작성·게이트 비활성, native 행동 유지 |
| 주 세션이 아닌 워커 | 전면 재분류 및 조정자 지침 삽입 안 함 |
| 일반 DEFAULT 턴 | 직접/단일 위임을 허용하는 가벼운 공통 지침 |
| 자동 ORCHESTRATE | 자체 병렬 위임 정책 추가, 기존 필수 리뷰 유지 |
| 현재 턴의 native explicit orchestrate notice | 같은 위치에서 자체 ORCHESTRATE notice로 교체; native/자체 지침 동시 노출 금지 |
| 현재 턴의 native `workflow-notice` (`workflowz`) | 명시적 workflow 실행 방식을 보존. 자체 지침은 계약·검증·리뷰 보조만 제공하며 task/workpool 선택이나 추가 fan-out을 지시하지 않음 |
| `workflowz` + 명시적 orchestrate 또는 자동 ORCHESTRATE | workflow 실행 방식 우선. native orchestrate notice만 보조형 자체 notice로 교체/축약하고, workflow notice는 그대로 유지 |
| 자동 routing disabled + 명시적 native 요청 | 자동 판단은 승격하지 않지만 명시적 요청은 자체 정책으로 처리 |
| native keyword 설정 disabled | native 명시 요청 탐지만 없어짐; 자체 자동 routing을 막지 않음 |
| task 비활성 | 위임 지침을 광고하지 않고 직접 실행; 리뷰 판단은 유지 |
| plan mode | 현재처럼 실행 조정 경로를 건너뛰고 native 제한 유지 |

세부 규칙:
- 자체 notice type은 `jev-orchestrate-notice`; native `orchestrate-notice`와 구분한다. 기본 실행형과 workflow 보조형을 렌더러의 명시적 분기로 구분한다.
- 실행 지침 우선순위는 현재 턴 `workflow-notice` > 현재 턴 explicit `orchestrate-notice` > 자동 ORCHESTRATE > DEFAULT다. 이 순위는 리뷰 승인·도구 권한을 완화하지 않는다.
- 현재 사용자 턴에 연결된 `orchestrate-notice`만 교체한다. 과거 턴·사용자 원문·다른 확장 메시지·native workflow notice는 삭제하지 않는다.
- provider context에만 적용하고 persisted native history를 변경하지 않는다. 공유 message 객체를 직접 수정하지 않고 교체본을 만든다.
- workflow가 없으면 실행을 지시하는 자체 notice는 한 개다. workflow가 있으면 native workflow notice 한 개와 중복 실행 지시가 없는 자체 보조 notice 한 개를 허용한다. 단순히 모든 notice 수가 1이어야 한다고 검사하지 않는다.
- 이미 자체 notice가 있어도 새 native notice 중복 여부를 먼저 처리한다. 재호출 시 내용·위치·timestamp 안정성을 유지한다.
- todo로 인한 자동 승격 위치, 늦게 도착한 이전 턴의 판단 무시, phase-boundary 판단은 보존한다.
- 패키지 비활성화/제거 후 native 지침이 다시 동작하도록 host 설정을 바꾸지 않는다.

### 6.1 Advisor 지침 합성 책임

현재 `src/orche-advisor.ts:120-138`은 `customType === "orchestrate-notice"`인 user-attributed 메시지에만 `ORCHESTRATE_GUIDANCE`를 추가한다. 새 타입으로 바꾸면서 이 소비자를 그대로 두면 전용 리뷰 안내가 누락된다. 이는 Opus 검토의 **[차단]** 지적이다. 부모 검토는 런타임 gate 자체가 사라지는 것은 아니라는 범위 보정을 했지만, 본 계획은 지침 연결 보완을 U3 완료의 필수 조건으로 취급한다.

- `src/orchestration-policy.ts`는 실행 정책만 작성한다. Advisor 안내는 `src/orche-advisor.ts`의 context hook 하나가 소유한다.
- U3에 `src/orche-advisor.ts`와 `test/advisor-integration.test.ts`를 추가한다. hook은 새 notice 타입과 기존 native 타입을 구분해 처리한다.
- 자체 정책 활성 상태에서는 현재 턴의 자체 실행형/보조형 notice에 안내를 한 번만 붙인다. 호스트 자체 메시지는 현재 턴 범위를 확인하고 처리하며 과거 메시지는 재가공하지 않는다.
- 현재 `src/index.ts`의 정책 context hook → review-gate guidance → Advisor hook 순서를 유지하고 통합 테스트로 검증한다. 실행 안내와 별도 pending-review notice는 역할이 다르므로 서로 삭제하지 않는다.
- 명시적 orchestrate, 자동 ORCHESTRATE, workflow 동시 활성화, context hook 재호출 각각에서 Advisor 안내가 누락·중복되지 않아야 한다.

## 7. 리뷰 계약과 승인 안전성

새 `src/task-contract.ts`로 `NormalizedCall`, `normalizeCall` 및 task 기본 이름 상수를 이동한다. 사용하지 않는 기존 export/re-export는 남기지 않는다.

- 사전 선언 정규화는 `pi.getAllTools()`가 노출하는 활성 native `task`의 `parameters`와 호스트가 사용하는 `@oh-my-pi/pi-ai`의 `validateToolArguments`를 재사용하는 `prepareDispatch` 경계로 모은다. `ToolInfo.parameters` 공개와 agent-loop의 해당 validator 사용은 소스에서 확인했지만, 이 조합의 플러그인 내 실행 정합성은 U1에서 검증해야 한다.
- `stageDispatch`는 원시 입력의 복사본을 위 경계로 검증한 뒤에만 staging한다. `beforeTool`은 이미 받은 effectiveArgs와 같은 경계의 결과가 동일한지 보장한다. wrapper 등록, task 인자 재작성, native schema 복제는 하지 않는다.
- top-level intent `i`는 호스트처럼 승인 계약에서 제외한다. default agent와 미등록 필드 처리는 공용 validator의 실제 결과를 따른다. 18.3.1 선행 실행에서 flat의 미등록 키는 유지됐고 batch item에서는 제거됐다. 직접 ArkType 호출의 제거 결과를 전체 host 경로로 일반화하지 않는다. 양쪽 shape 모두 task 본문·native default·반복 정규화의 멱등성을 확인했으며, 최종 실제 호출 parity는 별도로 검증한다.
- native task는 schema 검증 실패 시 lenient 원시 인자로 넘어가 실행 단계에서 오류를 설명할 수 있다. 이 경로를 정상 검증과 혼동하지 않는다. 사전 선언 실패는 staging/permit을 만들지 않고 이유를 반환한다. 실제 tool_call의 미검증·잘못된 shape에도 permit을 발급하지 않으며, 수정된 유효 호출로 다시 제출하도록 한다.
- task가 없거나 live schema/공유 validator를 안전하게 사용할 수 없으면 사전 선언을 명확히 거부한다. 수제 필드 목록이나 기본 agent 추정으로 조용히 대체하지 않는다. 설치 대상에서 이 경계가 성립하지 않으면 U1 차단이며 구현 완료로 보고하지 않는다.
- agent 생략 시 세션의 실제 native spawn-policy default를 따른다. 항상 task로 가정하지 않는다. 세션 기본값·동적 허용 목록을 복제한 별도 테이블은 만들지 않는다. 선언 후 설정이 바뀌면 현재 effective 계약으로 다시 비교하고, 달라졌다면 기존 승인을 사용하지 않는다.
- 승인 hash에는 전체 task/context와 기존 실행 관련 필드가 들어간다. 본문에 옮긴 설계 결정도 따라서 승인 범위에 포함된다.
- 로그/리뷰 요약의 길이 제한은 그대로 유지하지만, hash는 요약문을 사용하지 않는다.
- active alias→task 치환 코드는 U2의 router 제거와 같은 원자적 cutover에서 삭제한다. U1 준비 단계는 기존 치환 동작을 보존한다. 최종 상태에서는 제거한 별칭 호출을 몰래 task로 바꾸지 않는다.
- dispatch/receipt 계약 버전을 올려 구버전 승인을 새 의미로 재사용하지 않는다. 재개한 구 세션은 실행 전에 새 리뷰를 요구한다.
- 현재의 batch fan-out gate, 필수 리뷰, 취소/withdrawal, finding revision, 실패/미가용 구별, user waiver를 보존한다.
- `before_subagent_spawn`의 native permit과 eval/workpool fingerprint 보호를 유지한다.
- 승인된 계약과 다른 호출, stale permit, 추가 워커, 위임되지 않은 직접 spawn은 차단한다.
- 재시도 시 permit 중복 발급·소모에 관한 기존 동작을 회귀 검증한다. 새 일반 재시도 엔진은 넣지 않는다.

### 7.1 Permit 발급·소비·폐기

이 절은 permit 수명에 대한 구현 명세이지, Opus가 가설로 제시한 다른 spawn 경로의 우회를 확인했다는 선언이 아니다.

- 발급 장부는 `(sessionId, scopeKey, toolCallId, itemIndex)`와 정규화된 계약/agent/name을 기록한다. `src/index.ts`가 실제 `toolCallId`를 gate로 전달하도록 한다. 같은 호출의 hook 재실행으로 permit을 중복 발급하지 않는다.
- native spawn 직전에 소비하며 한번 소비한 permit은 다시 쓰지 않는다. scope/finding revision 변경, withdrawal, branch/session 종료 시 미소비 permit을 폐기한다.
- 오류 또는 차단된 task `tool_result`에서는 해당 호출의 미소비 permit을 폐기한다. 이미 실행한 worker의 기록/사용량은 삭제하지 않는다.
- 정상 동기 완료에서도 해당 호출의 잔여 permit을 정리한다. 정상 비동기 반환은 worker 종료가 아니므로 그것만으로 대기 중 permit을 폐기하지 않는다. 대기 중 취소·preflight 실패·shutdown의 정리 시점을 native lifecycle과 맞춘다.
- 공개 `BeforeSubagentSpawnEvent`에는 agent/invocationKind/patterns/spawnKey만 있고 parent toolCallId나 task 원문이 없다. 따라서 발급 장부의 toolCallId를 spawn event에서도 읽을 수 있다고 가정하지 않는다.
- hook의 `spawnKey` 문자열만 발급 장부와 비교한다. 18.3.1 native task의 명시적 이름은 async `outputManager.allocate(trimmedName)`에서 원문 또는 `-N` suffix ID가 되고, sync hook은 label 또는 `${toolCallId}:${index}` 문자열을 사용한다. hook에 name/toolCallId/index 필드가 있다고 가정하지 않는다. 겹치는 name/suffix 후보는 발급 전에 차단하고 고유한 이름으로 재제출하도록 한다.
- 동기 unnamed는 실제 toolCallId:index로만 매칭한다. async 설정에서 랜덤 이름을 선할당할 수 있는 구현 워커에는 명시적 native `name`을 요구한다. 임의 spawnKey에 대한 wildcard permit을 발급하지 않는다. 이는 식별 불가능한 경로를 제한한다는 7.1절의 안전 규칙을 구체화한 것이다.
- 이 matching은 호스트 이벤트가 제공하는 범위의 보호이며, 임의 내부 spawn의 출처를 암호학적으로 증명하지 않는다. 다른 native 경로가 같은 identity를 제시할 수 있는지, async 호출이 큐 대기 전에 hook을 거치는지는 U2 통합 검증 항목이다. 현 API로 필요한 구분을 할 수 없으면 해당 경로를 제한하거나 차단 사유를 보고하며, 추정으로 permit을 소비하거나 호스트 본체를 몰래 수정하지 않는다.
- A2는 restricted child에서 native 기본값을 재작성하지 않는 확인이다. primary-only 리뷰의 선언/실행 계약 검증은 별도 A17, permit 수명은 A19로 검증한다.

## 8. 제거와 보존 범위

### 제거

- `src/task-routing.ts`의 classifier/router 및 나머지 dead code. 필요한 정규화는 먼저 이동.
- `src/deep-agent.ts` 및 `scripts/gen-deep-agent.ts`.
- 플러그인 소유 `agents/task-easy.md`, `agents/task-hard.md`, `agents/task-challenge.md`.
- `src/jev.ts`의 task route 타입, 기준, instructions, `JevSubtask`, `decideTaskTiers`.
- 설정: `taskRoutingEnabled`, `taskMinConfidence`, `taskMinMargin`, `easyTaskRole`, `hardTaskRole`, `challengeTaskRole`.
- tier role 자동 생성, alias materialization/discovery/cache 및 상태 표시.
- `package.json`의 해당 setting metadata, `gen:agents`, build의 generation 단계.
- `/jev-router test`의 tier probe 및 tier-only fixtures/tests.

### 보존

- 패키지 이름과 `/jev-router` 명령. 불필요한 제품 rename은 하지 않음.
- 전면 분류용 SDK/자격증명, DEFAULT/ORCHESTRATE 및 리뷰 판단.
- Orche-Advisor, Verification Auditor, finding ledger, review gate.
- 사용자 `@task` 모델 설정과 전문/custom agent 설정.
- 과거 telemetry/decision 원본. 새 기록과 섞어서 새 동작의 성능으로 제시하지 않음.

사용자 전역에 남은 `task_easy/task_hard/task_challenge` 모델 역할은 삭제·덮어쓰지 않는다. 사용자 소유 설정이므로 새 코드에서 참조하지 않고 상태 화면에서 필요 시 미사용임을 알린다. 플러그인 디렉터리 밖 agent 파일도 임의로 삭제하지 않는다.

## 9. telemetry, 진단, 이력 전환

- telemetry v5로 전환한다. v4 task 분류 counters는 `historical.taskRouting`, 기존 workers 전체는 `historical.workers`로 보존한다. `workers.task`도 예외가 아니다. 기존 legacy 수치를 보존하고 v5 live workers는 비어 있는 새 epoch에서 시작한다.
- 기존 `spawns`는 라우팅 선택 수였으므로 새 실제 실행 시작 수로 재해석하지 않는다. v5는 관찰된 시작 `startedObserved`, 종료별 `completed/failed/aborted`, 사용량 표본 `usageSamples`, 사용량 미관찰 `usageUnknown`을 구분한다. 이를 과거 tier 수치와 합산하지 않는다.
- migration은 멱등이며 9.1절 방식으로 원본 v4 스냅샷을 보존한다. decision JSONL의 과거 행은 수정하지 않는다. 신규 행에는 정책 버전과 epoch를 명시하고 task tier 결정 행은 더 이상 쓰지 않는다.
- 집계 단위는 **이름이 `task`인 워커**이며 task 도구에서 왔다고 단정하지 않는다. 현재 lifecycle에는 invocationKind가 없으므로 eval agent()/workpool 등도 포함될 수 있다. UI는 이를 “task 워커 — 호출 경로 미분리”로 표시한다. 전문/custom agent는 이번 live 집계 확장의 대상이 아니며 과거 이력은 보존한다.
- 사용량은 관찰한 최종 progress에서만 얻는다. settlement만 있으면 종료 상태와 `usageUnknown`을 기록하고 tokens/cost/duration을 0으로 만들어내지 않는다. `startedObserved`도 채우지 않는다. 시작은 host의 명시적 시작 또는 최초 progress를 관찰했을 때만 한 번 기록한다.
- host의 `aborted`를 저장 상태로 유지하고 UI에서 “취소”로 표시한다. `cancelled`라는 host 원시 상태를 가정하지 않는다.
- 종료 집계의 dedupe와 usage 집계의 dedupe를 구분한다. 한 버스에서 settlement-only가 먼저 오고 다른 버스에서 관찰된 progress+settlement가 나중에 오면 종료는 1회 유지하고 unknown을 측정 표본으로 한 번만 승격한다. 기록이 없는 비용은 평균/비용당 완료 분모에 섞지 않으며 표본 커버리지를 표시한다.
- 기존의 안정적인 worker identity를 부모/자식 버스에서 공유하되 epoch별로 관리한다. 이벤트 순서·중복·missed progress는 `test/telemetry.test.ts`의 기존 worker tracking 사례를 확장해 확인한다.
- `completed`는 워커 실행 완료이며 인수 성공률이 아니다. status는 정책/epoch, 자동 routing, native task 역할, review scope, 관찰된 live usage와 historical을 구분한다.
- diagnostics: 전면 Jev 요청만 수행. task 분류 API는 호출하지 않음. 별칭 미존재를 에러로 표시하지 않음.

### 9.1 백업과 원자적 전환

- 플러그인 stateDir의 `telemetry-history/`를 migration 스냅샷 전용으로 사용한다. 파일명은 `v<version>-<원본 SHA-256>.json`으로 고정한다. 같은 바이트는 중복 생성하지 않으며 기존 파일을 덮어쓰지 않는 exclusive create와 hash 확인을 사용한다.
- 모든 writer가 종료된 전환 시점에만 migration을 실행한다. 원본 백업 완료 → v5 변환을 sibling 임시 파일에 기록 → active `telemetry.json`으로 원자적 rename 순서를 사용한다. 백업/쓰기 실패 시 원본 active 파일을 남기고 migration 미완료를 알린다. 임의로 빈 counters를 저장하지 않는다.
- v5 active가 이미 있으면 다시 migration하지 않는다. 중단 후 재개 시 같은 원본 hash의 백업 존재를 확인하고 같은 변환을 수행한다. 운영 중 다중 프로세스 파일 잠금 서비스를 새로 만들지 않는다.
- 자동 읽기에서 알 수 없는 미래 버전을 빈 상태로 덮어쓰지 않는다. 버전 불일치를 표시하고 쓰기를 중단해 명시적 전환을 요구한다.
- `/jev-router reset`은 현재 telemetry/decisions, `telemetry-history/`의 플러그인 소유 snapshot, 해당 migration 임시 파일을 삭제한다. 기존 `telemetry.v<N>.json`도 정확한 파일명 패턴의 과거 플러그인 백업만 대상으로 한다. 타 파일과 사용자 별도 export는 건드리지 않는다.
- reset 전에 pending append/flush를 정리하고 dedupe/epoch/migration cache를 비워야 한다. 삭제 실패를 성공처럼 보고하지 않는다. 다시 시작할 때 삭제한 스냅샷에서 기록이 부활하지 않아야 한다.

## 10. 구현 단위와 의존 순서

| 단위 | 주요 파일 | 완료 조건 |
| --- | --- | --- |
| U1 계약 준비 | 신규 `src/task-contract.ts`; `src/review-gate.ts`, `src/host.ts`; 관련 테스트 | live-schema 검증 경계와 정규화 분리. 기존 tier 치환/승인 동작 유지. 호환성 증거 확보 |
| U2 단일 task 원자적 cutover | `src/index.ts`, `src/runtime.ts`, `src/review-gate.ts`, `src/jev.ts`, `src/config.ts`, `src/host.ts`, `src/logging.ts`; 제거 파일·agents·scripts; `package.json` | router·alias 치환·tier 설정 제거와 승인 버전 전환을 함께 적용. toolCallId 발급 장부·permit lifecycle 포함 |
| U3 자체 정책 | 신규 `src/orchestration-policy.ts`; `src/orchestration.ts`, `src/orche-advisor.ts`; `test/orchestration.test.ts`, `test/advisor-integration.test.ts` | DEFAULT/자동/명시/workflow 정책 우선순위, Advisor 지침 1회 합성, 과거 notice 불변 |
| U4 관측·운영 | `src/telemetry.ts`, `src/worker-usage.ts`, `src/commands.ts`; telemetry/status/config 테스트 | epoch/history 분리, unknown usage, 백업·reset·왕복 전환 절차 |
| U5 통합 검증·문서 | `test/harness.ts`, `test/jev.test.ts`, `test/review-gate.test.ts`, `test/advisor-integration.test.ts`, 나머지 영향 테스트; `README.md`, 기존 예제 | 아래 수용 기준과 버전별 host smoke 충족, 낡은 티어 사용법 제거 |

의존성: U1 → U2, U1 → U3, U2+U3 → U4 → U5.
U1은 동작 보존 추출이며, alias 치환 제거와 router 제거를 U1/U2 사이로 분리하지 않는다. U2의 승인 버전·permit 변경도 같은 통합 변경에 포함한다. U2와 U3는 U1의 API가 확정되고 파일 소유권이 분리되면 병렬 구현 가능하다. `index.ts`/`runtime.ts` 및 최종 통합은 한 명이 소유한다. 최종 배포는 U1–U5 전체 완료 뒤 한 번 수행하며 중간 branch 상태를 운영에 배포하지 않는다. 이 문서는 실제 위임 배치의 실행 승인이 아니다.

영향 테스트 처리:
- `test/task-routing.test.ts`: router 제거와 함께 삭제. 살아 있는 normalization 사례는 task-contract 테스트로 옮긴다.
- `test/deep-agent.test.ts`: 별칭 생성 기능과 함께 삭제.
- `test/harness.ts`: tier decider와 alias 기본 목록 제거.
- `test/jev.test.ts`: task 분류 request/budget 케이스 제거, 살아 있는 전면 분류 검증 유지.
- `test/review-gate.test.ts`: worker 정체성 사례를 native task로 전환하되 보호 동작을 약화하지 않는다.
- `test/review-output.test.ts`: 별칭명에 의존하는 fixture만 native 이름으로 전환하고 검증 의미 유지.
- `test/config.test.ts`, `test/status.test.ts`, `test/telemetry.test.ts`: 새 계약과 과거 기록 migration 경계 검증.
- `test/advisor-integration.test.ts`: 새 notice와 Advisor 안내의 연결, 등록 순서, 현재/과거 턴, workflow 보조형의 중복·누락 검증.
- `test/telemetry.test.ts`의 기존 worker tracking 사례: settlement-only, 중복 버스, unknown→측정값 승격, aborted 매핑, v4 `workers.task` 이력 분리, reset 후 복구 금지까지 확장한다. 테스트가 없다고 가정해 중복 suite를 만들지 않는다.
- 프롬프트 문구 일치나 단순 전달 복제만 확인하는 테스트는 추가하지 않는다.

## 11. 수용 기준과 검증 매트릭스

| ID | 시나리오 | 반드시 관찰할 결과 |
| --- | --- | --- |
| A1 | 일반 task 1개 실행 | agent=task, native @task 해석, tier 네트워크 호출 0회 |
| A2 | restricted 부모의 agent 생략 | primary 리뷰와 별개로 native effective default/허용 정책 유지, task로 강제하지 않음 |
| A3 | 전문/custom agent 명시 | 원래 정체성·도구 권한 유지 |
| A4 | 자동 ORCHESTRATE | 자체 정책 1개, primary model 변경 없음 |
| A5 | native explicit orchestrate + 자동 판단 + context 재호출 | 현재 턴 자체 실행 지침과 Advisor 안내 각각 1회, 과거 notice 불변 |
| A6 | master off / auto off / keyword off / task off / plan mode | 6절의 각각 다른 의미대로 동작; workflow와의 우선순위는 A18로 별도 검증 |
| A7 | 변경 없는 승인 배치 재제출 | 정해진 워커만 실행, 단순 상태 변경으로 불필요한 재리뷰 없음 |
| A8 | 본문 설계 결정·context·도구·agent 변경 | 과거 승인 거부, 새 scope 필요 |
| A9 | old receipt / withdrawal / branch switch / finding revision | 오래된 승인으로 새 실행 불가 |
| A10 | eval agent()/workpool 실행 | 기존 공통 spawn 리뷰 보호 유지, 별도 무승인 경로 없음 |
| A11 | async 두 작업 중 취소·실패·정상 완료 | native 취소·이벤트·정리 유지, aborted 매핑, 종료/usage 중복 없음 |
| A12 | 작업 계약을 기존 task 본문으로 전달 | 워커가 확정 결정과 미해결 판단을 실제로 수신하고 반영 |
| A13 | native batch/isolated/effort/eval-tools 설정 조합 | 리뷰 승인 후 native preflight의 허용·거부와 실행 의미 유지. identity 모호성에 대한 추가 거부는 A19로 명시적 검증 |
| A14 | v4→v5 재실행 및 rollback→재업그레이드 | 충돌 없는 원본 보존, migration 멱등, epoch별 구분, 이중 합산 없음 |
| A15 | 고정 의존성과 실제 운영 CLI 각각의 host 경유 | 버전·실행 경로 기록, native validation → 리뷰 → spawn → 산출물 → 인수 검증 관찰 |
| A16 | plugin disable/uninstall | OMP task와 native orchestrate 복원, 사용자 역할/전역 agent 무변경 |
| A17 | primary 사전 선언의 agent 생략·미등록 필드·flat/batch·설정 변경 | live-schema 결과와 effectiveArgs 계약 일치; 실패 시 미승인/staging 없음, 다른 계약은 재리뷰 |
| A18 | workflowz 단독·자동 ORCHESTRATE·명시적 orchestrate 동시 활성화 | workflow 실행 방식 보존, 자체 보조 지침만 추가, Advisor 1회, 중복 dispatch 지시 없음 |
| A19 | preflight 실패·호출 취소·동일 호출 재진입·같은 이름 동시 호출·async 큐 대기 | 미소비 permit 누수/중복 소비 방지, 모호한 identity 거부, 정상 async를 조기 폐기하지 않음 |
| A20 | progress 미관찰·중복 버스·뒤늦은 측정값·task 도구/eval 혼재 | unknown을 0으로 위조하지 않음, 종료 1회, 측정값 승격 1회, 호출 경로 미분리 표시 |
| A21 | 백업/active 기록 중 실패·미래 버전·reset 후 재시작 | 원본 유지, 잘못된 빈 counters 저장 금지, 소유 백업 삭제, 기록 부활 없음 |

검증 층:
1. deterministic contract tests: review 해시/상태 전이, 정규화, telemetry migration, stale result/중복 notice 경계.
2. disposable smoke: 먼저 실행 파일 경로, CLI 버전, 로드된 plugin/dependency 버전을 기록한다. 고정 의존성 **18.3.1 실행 환경**과 현재 운영 CLI **18.3.4 실행 환경**을 분리해 실제 task 호출을 검증한다. payload를 라우터에 직접 넣는 검증으로 대체하지 않는다. 각 버전에서 validation/defaults, spawn identity, lifecycle payload, notice 주입 계약을 확인하고 폐기 가능한 저장소·분리된 agent-state를 사용한다. 한 환경만 실행했다면 다른 버전 호환성을 주장하지 않는다.
3. 같은 환경에서 순차 의존 작업과 독립 병렬 작업을 각각 실행해 계약·검증 책임을 관찰한다. 별도 solutionSpace 필드를 넣어 통과한 것처럼 보고하지 않는다.
4. 최종 체크: `bun run check`, `bun run lint`, `bun test`. 사라진 generator를 포함하는 이전 build 경로를 실행하지 않는다.
5. 실제 host smoke를 실행할 모델/자격증명이 없으면 정확히 제한을 보고하고 A15 미충족으로 남긴다. unit/local endpoint 성공만으로 구현 완료 처리하지 않는다.
6. 18.3.4에서 계약이 달라지면 이 계획 안에서 무조건 의존성을 올리지 않는다. 차이를 호환성 blocker로 기록하고 지원 범위를 명시한다. 스키마 조회 API 존재만으로 실제 normalization 경로 검증을 대신하지 않는다.

제품 동작 완료와 비용 우월성은 구별한다. 비용 비교는 같은 작업·모델·환경·반복 횟수에서 native 정책+task와 자체 정책+task를 비교한다. 실행한 도구 횟수보다 인수 성공률, 총 모델 비용, wall time, 재작업/충돌/누락을 기록한다. 대표 작업에는 기계적 수정, 순차 버그 수정, 독립 구현, 공유 계약 변경, 취소/재개를 포함한다. 연구/공개 플러그인 인기는 수용 테스트의 대체물이 아니다.

## 12. 배포와 되돌리기

- 기존 plugin package 이름으로 단일 cutover한다. 티어 병행 모드나 compatibility alias는 남기지 않는다.
- README에 breaking changes: 삭제한 설정/역할 사용, native @task 준비, 본문 계약, 새 notice 의미, 과거 telemetry 구분을 명시한다.
- 삭제한 plugin setting 키는 새 validator/metadata에서 제거하며 구 저장값은 동작에 사용하지 않는다. 읽기 단계에서 사용자 설정 파일을 자동 수정하지 않는다. status가 해당 구키를 발견하면 마이그레이션 안내를 제공한다.
- 사용자 @task 미설정/미해결 시 상태에 명확히 표시하고 native 오류를 숨기거나 @slow로 우회하지 않는다.
- 진행 중인 워커를 둔 live cutover는 하지 않는다. 작업 종료 후 새 세션에서 전환한다. host가 허용하는 reload만으로 hook/도구 상태까지 안전하다고 가정하지 않는다.
- 패키지 관리 설치는 제거 파일이 남지 않는 clean package payload로 배포한다. 링크 설치는 플러그인 소유 삭제 대상만 제거한다.
- rollback 절차: 모든 관련 프로세스 종료 → 현재 v5 active를 `telemetry-history/v5-<원본 SHA-256>.json`, decisions를 `telemetry-history/decisions-<원본 SHA-256>.jsonl`에 exclusive create로 보존 → 사용할 v4 snapshot의 hash/버전을 확인 → snapshot 복사본을 active telemetry로 원자적 복원 → 이전 패키지를 시작한다. 구버전이 v5 active를 직접 읽게 두지 않아 고정 이름 `telemetry.v5.json` overwrite 경로를 피한다. 원래 decisions는 계속 보존하고 위 archive는 시점별 복사본이며 자동 집계 입력으로 사용하지 않는다.
- 재업그레이드 절차: 프로세스를 종료하고 rollback 기간의 최신 v4 active도 별도 snapshot으로 보존한다. 새 v5 epoch로 시작하고 해당 v4는 historical로 변환한다. 이전 v5 epoch archive는 별도로 유지하되 새 live/historical에 자동 합산하지 않는다. 겹치는 기간을 추정해 병합하지 않는다.
- decisions 원본은 정책/epoch별로 구분해 보존한다. rollback 중 구버전이 추가한 version/epoch 없는 행을 새 v5 성능으로 합산하지 않는다. reset의 archive 삭제 범위는 9.1절을 따른다.
- 구현 완료 보고에는 A1–A21의 통과/미실행/차단 및 실제 실행 버전을 분리한다. 기록된 finding은 실제 수정 근거로만 별도 처리한다.

## 13. 최종 Definition of Done

- 일반 task 티어 분기·별칭·관련 API/설정/생성기/사용법이 active 경로에 없음.
- native task 모델·권한·기본 agent·비동기 동작을 유지.
- workflow가 없으면 자체 정책이 유일한 실행 지침이다. 명시적 workflow가 있으면 그 실행 방식을 보존하고 자체 계약/검증 안내만 보조하며, 중복 실행 지시나 Advisor 안내 누락이 없다.
- 본문 계약의 설계 정보가 실제 워커까지 전달됨.
- 기존 리뷰 보호와 사용자 권한을 유지하고 과거 승인을 재사용하지 않음.
- 과거 이력과 live epoch 분리, unknown 사용량, reset/rollback/재업그레이드 규칙 검증 완료.
- 지원 대상으로 명시한 OMP 버전별 실제 host smoke와 타입/lint/test 검증 완료. 미실행 버전은 지원 검증 완료로 표시하지 않음.
- 코드상 완료, 인수 검증 완료, 비용 비교 결과를 서로 혼동하지 않는 보고.

### 검토 지적 반영표

이 표는 문서의 설계 보완 내역이며 제품 수정·실행 검증·기존 finding closure를 뜻하지 않는다. Opus 5.5 검토는 모델을 지정한 별도 CLI 프로세스로 수행했으며 native `task` 서브에이전트 dispatch 증거는 아니다.

| 검토 항목 | 근거와 판정 | 계획 반영 |
| --- | --- | --- |
| Advisor 새 notice 연결 | Opus [차단]. 부모는 runtime gate 소멸과 구분하되 지침 누락은 확인 | 6.1절, U3, A5/A18 |
| predeclare/effectiveArgs 정규화 | API 스키마 노출과 공유 validator 사용은 확인; 동일 실행 결과는 미검증 | 7절, U1, A17 |
| 사용량·상태·집계 경계 | 미관찰 usage 기록 요구와 실제 progress 기반 계약 불일치 | 9절, A11/A20 |
| migration/rollback/reset | 데이터 손실 발생 주장이 아니라 보존 절차의 명세 부족 | 9.1/12절, A14/A21 |
| U1/U2 중간 상태 | 배포된 장애가 아니라 치환/router 전환 순서 위험 | U1 동작 보존, U2 원자적 cutover |
| workflowz 병존 | native workflow 실행 지침 존재, 이전 계획 우선순위 누락 | 6절, A18 |
| 18.3.1/18.3.4 | 소스 근거와 실행 CLI 버전 차이; 호환 실패는 아직 미확인 | 3/11절, A15 |
| permit 수명 | 내부 spawn 우회는 가설; hook의 caller 식별 제한은 확인 | 7.1절, U2, A19 |

## 14. 참고한 공개 방법론

- [Compound Engineering ce-work](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/guides/ce-work.md): 조건부 병렬화, host-owned verification, caller-owned 실행.
- [Compound Engineering OMP spec](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/specs/omp.md): 기존 task/todo/ask 재사용. 해당 문서의 검증 버전은 17.2.9로, 우리 18.3.1의 호환성 증거가 아님.
- [Superpowers parallel dispatch](https://github.com/obra/superpowers/blob/main/skills/dispatching-parallel-agents/SKILL.md): 독립성·자기완결적 계약. 전체 SDD의 모델 티어/매 작업 리뷰/직렬 구현 규칙은 채택하지 않음.
- [GSD phase loop](https://github.com/open-gsd/gsd-core/blob/main/docs/explanation/the-phase-loop.md): 실행 완료와 요구사항 검증 구별. 별도 상태 파일 체계 전체는 도입하지 않음.

공개 프로젝트를 설치하지 않았고, 해당 프로젝트의 별점/설치 수를 성능 근거로 사용하지 않는다.

## 15. 구현 및 검증 결과

검증일: 2026-09-27. 코드에 tier classifier/alias/generator가 남는 병행 모드는 만들지 않았다. `task-contract.ts`, 자체 정책, 리뷰/permit, telemetry v5 및 설정·진단·README까지 통합했다.

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
