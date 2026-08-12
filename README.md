# Zabbix Investigation MCP

Zabbix API의 읽기 전용 데이터를 n8n AI Agent에 제공하는 독립 MCP 서버입니다.
Agent가 조사할 호스트·메트릭·시간 범위·집계 간격을 결정하고, 이 서버는 입력
검증과 Zabbix 조회, 수치 집계를 결정론적으로 수행합니다.

## 제공 도구

- `find_hosts` — 이름으로 검색하거나, `group_ids`로 호스트 그룹에 속한 호스트를
  나열합니다. 후자는 질문이 호스트를 지목하지 않는 조사(정기 보고서 등)가
  대상을 정하는 경로입니다. 둘 중 하나는 반드시 필요합니다.
- `get_incident_events`
- `get_trigger_details`
- `list_relevant_metrics`
- `get_metric_summary`
- `get_metric_history`
- `get_related_events`
- `query_zabbix` — 위 도구들이 모양을 잡아 주지 않는 질문을 위한 통로. 아래에서
  따로 설명합니다.

Zabbix 설정 변경, 이벤트 확인 처리, 스크립트 및 원격 명령 실행 도구는 제공하지
않습니다.

### 시각은 두 가지로 돌아옵니다

이벤트와 조회 구간에는 `started_at`·`recovered_at`·`window`(UTC)와 함께
`started_at_local`·`recovered_at_local`·`window_local`이 붙습니다.

```json
{ "started_at": "2026-08-11T02:22:40.000Z",
  "started_at_local": "2026-08-11 11:22:40 (Asia/Seoul)" }
```

UTC 하나만 주면 `02:22:40Z`를 새벽 2시로 읽고 다른 도구에 `02:22+09:00`으로
넘기는 일이 생깁니다. 조회는 9시간 어긋난 채 **성공하고**, 빈 결과가 "그때는
조용했다"로 읽힙니다. 시각을 만들어 내는 쪽에서 두 표기를 함께 주면 추론할
일이 없어집니다. 표기할 때는 `_local`을, 다른 도구에 넘길 때는 `Z` 쪽을 씁니다.

### `query_zabbix` — 임의 `.get` 메서드 통로

전용 도구가 답할 수 없는 질문("이 호스트에 어떤 템플릿이 붙어 있나", "이
트리거의 원문 식은 무엇인가")을 위해 Zabbix `.get` 메서드를 그대로 호출합니다.
쓰기 메서드는 목록에 없어서 도달하지 않습니다.

넘겨준 파라미터를 그대로 보내지 않고 **경계를 질의 안으로 밀어 넣습니다.**

| 메서드 | 제한 방식 |
|---|---|
| `host.get` `hostgroup.get` `item.get` `trigger.get` `event.get` `problem.get` `graph.get` `httptest.get` | `groupids`를 허용 그룹과 교집합해서 주입 |
| `hostinterface.get` | `hostids`가 필수이며 호스트마다 접근 권한 확인 |
| `dashboard.get` `template.get` `usermacro.get` `auditlog.get` | 호스트에 매이지 않아 그룹 제한이 성립하지 않음 |

교집합이 비면 **오류를 냅니다.** 빈 결과로 돌려주면 "그 그룹에 아무것도 없다"로
읽히고, 제한을 풀어 전체를 돌려주면 경계가 조용히 사라집니다.

응답은 행 수(`INVESTIGATION_MAX_RAW_ROWS`)와 문자
수(`INVESTIGATION_MAX_RAW_RESULT_CHARS`) 양쪽으로 자릅니다. 모든 필드를 선택한 한 행이 좁은 백 행보다 클 수 있어서 행
수만으로는 상한이 되지 않습니다. `params_applied`에는 **받은 질의가 아니라
실제로 보낸 질의**가 담깁니다.

## 환경 변수

```powershell
Copy-Item .env.example .env
```

필수 설정:

- `ZABBIX_URL`: `/api_jsonrpc.php`를 포함한 Zabbix API URL
- `ZABBIX_API_TOKEN`: 읽기 전용 API Token
- `ZABBIX_ALLOWED_HOST_GROUP_IDS`: 조회를 허용할 Host Group ID 목록.
  비워 두면 토큰이 볼 수 있는 **모든** 호스트가 조사 대상이 됩니다. 제한은
  그룹 단위로만 동작하므로, 특정 호스트 몇 대만 대상으로 삼으려면 Zabbix에
  전용 호스트 그룹을 만들어 그 ID 하나만 지정하십시오. 기존 운영 그룹을
  그대로 쓰면 의도하지 않은 호스트까지 함께 열립니다.

  `find_hosts`가 `group_ids`로 그룹을 지정해도 이 목록이 상한입니다. 목록에
  없는 그룹은 결과에서 제외되고 `excluded_group_ids`로 알려 주며, 요청한
  그룹이 전부 목록 밖이면 빈 결과가 아니라 오류를 냅니다 — 빈 결과는 "그
  그룹에 호스트가 없다"로 읽히는데 그건 다른 사실입니다.
- `ZABBIX_MCP_AUTH_TOKEN`: MCP 클라이언트가 사용할 Bearer Token

선택 설정:

- `ZABBIX_RAW_QUERY_METHODS`: `query_zabbix`가 제공할 메서드 목록. **Zabbix
  역할이 실제로 허용하는 것만 적습니다.** 역할이 거부하는 메서드를 목록에 두면
  호출을 한 번 해 봐야 알 수 있고, 그 왕복은 조사 시간에서 나갑니다. 비워 두면
  서버가 아는 전부를 제공합니다.

  서버가 모르는 이름이 있으면 **기동하지 않고 오류를 냅니다.** 오타 하나를
  조용히 버리면 설정했다고 믿는 것보다 적은 권한으로 돌아가고, 그 사실을 알려
  주는 곳이 없습니다.
- `DEFAULT_TIMEZONE` (기본 `Asia/Seoul`): `..._local` 표기에 쓰는 시간대.
- `INVESTIGATION_MAX_RAW_ROWS` (기본 `50`),
  `INVESTIGATION_MAX_RAW_RESULT_CHARS` (기본 `12000`)

나머지 한도(`INVESTIGATION_MAX_WINDOW_HOURS`, `INVESTIGATION_MAX_EVENTS` 등)는
`.env.example`에 기본값과 함께 주석으로 설명해 두었습니다.

`ZABBIX_MCP_AUTH_TOKEN`은 길고 무작위인 값을 사용합니다.

```powershell
[Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLower()
```

## Docker 실행

```powershell
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://127.0.0.1:3000/healthz
```

기본 엔드포인트:

- MCP: `http://<instance-a>:3000/mcp`
- 상태 확인: `http://<instance-a>:3000/healthz`

MCP 요청에는 다음 헤더가 필요합니다.

```text
Authorization: Bearer <ZABBIX_MCP_AUTH_TOKEN>
```

## 네트워크 노출 제한

컨테이너 포트가 게시되는 호스트 인터페이스는 `MCP_BIND_ADDRESS`가 정합니다.

```dotenv
MCP_BIND_ADDRESS=192.168.20.22   # 이 머신의 사설 IP
```

값을 지정하지 않으면 `127.0.0.1`로 게시되므로, 설정을 빠뜨려도 공인
인터페이스에 열리지 않습니다.

`MCP_HOST`와 혼동하지 않아야 합니다. `MCP_HOST`는 프로세스 자체의 바인드
주소이고 docker compose에서는 컨테이너 내부 기준 `0.0.0.0`으로 고정됩니다.
호스트 노출을 실제로 통제하는 값은 `MCP_BIND_ADDRESS`입니다.

Docker는 자신의 forwarding 규칙을 ufw보다 앞에 삽입하므로, `0.0.0.0`으로
게시한 포트는 호스트 방화벽으로 막히지 않습니다. 방화벽에 의존하지 말고 바인드
주소를 지정하십시오. 클라우드 보안 그룹에서도 3000 포트를 사설 대역으로
제한하는 것을 권장합니다.

적용 결과는 실행 전에 확인할 수 있습니다.

```powershell
docker compose config
```

```yaml
ports:
  - host_ip: 192.168.20.22
    published: "3000"
    target: 3000
```

`MCP_ALLOWED_HOSTS`는 소스 IP가 아니라 요청의 `Host` 헤더를 검사합니다. DNS
rebinding 방어용이며 네트워크 접근 제어를 대신하지 않습니다.

운영 환경에서는 3000 포트를 인터넷에 그대로 공개하지 말고 HTTPS reverse
proxy, 방화벽 또는 사설 네트워크를 사용합니다.

## 로컬 개발

요구 사항은 Node.js 20 이상입니다.

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

## 실제 Zabbix 통합 테스트

`tests/integration/`은 실제 Zabbix API에 붙어 7개 도구와 정책 가드레일을
검증합니다. 환경 변수가 없으면 자동으로 건너뛰므로 `npm test`와 CI는 Zabbix
없이도 그대로 통과합니다.

Zabbix가 사설망에 있으면 먼저 터널을 엽니다.

```powershell
ssh -N -L 8081:<zabbix-host>:80 <jump-host>
```

```powershell
$env:ZABBIX_INTEGRATION_URL = "http://127.0.0.1:8081/zabbix/api_jsonrpc.php"
$env:ZABBIX_INTEGRATION_HOST = "<조사할 호스트 이름>"
npm run test:integration
```

- `ZABBIX_API_TOKEN`은 지정하지 않으면 저장소 `.env`에서 읽습니다. 토큰을
  명령줄에 노출하지 않아도 됩니다.
- 세 변수(`ZABBIX_INTEGRATION_URL`, `ZABBIX_API_TOKEN`,
  `ZABBIX_INTEGRATION_HOST`)가 모두 있어야 실행됩니다.
- 대상 호스트에 이벤트가 없으면 이벤트 관련 단정은 건너뛰고, 나머지 계약과
  가드레일은 그대로 검증합니다.

## 토큰 권한

Zabbix 역할(User role)의 **API methods**를 `Allow list`로 두고 필요한 메서드만
체크합니다. 전용 도구 7개는 다음 6개면 동작합니다.

```text
host.get  event.get  trigger.get  item.get  history.get  trend.get
```

`query_zabbix`까지 쓰려면 제공하려는 메서드를 역할에도 함께 허용하고, 같은
목록을 `ZABBIX_RAW_QUERY_METHODS`에 적습니다. 현재 배포에서 쓰는 조합입니다.

```text
hostgroup.get  hostinterface.get  problem.get  graph.get
httptest.get   dashboard.get      template.get usermacro.get
```

`auditlog.get`은 메서드 허용만으로는 부족하고 **감사 로그를 읽을 수 있는 사용자
유형**이 필요합니다. 그래서 기본 목록에서 빠져 있습니다.

역할에는 읽기 권한만 두고, 호스트 그룹 접근은 `ZABBIX_ALLOWED_HOST_GROUP_IDS`와
Zabbix 쪽 권한 **양쪽에서** 좁힙니다. 이 서버의 그룹 제한은 편의를 위한 것이지
Zabbix 권한을 대신하지 않습니다.

## 집계 정책

- 짧은 범위는 `history.get` 원시 값을 지정 간격으로 집계합니다.
- 오래된 장기 범위는 `trend.get` 결과를 재집계합니다.
- 결과에 `data_source`, `sample_count`, `coverage_ratio`, `partial`을 포함합니다.
- 장기 조회는 최소 1시간 집계만 허용합니다.
- LLM은 평균·최댓값을 계산하지 않고 MCP가 반환한 값을 해석합니다.

`partial`은 다음 중 하나라도 해당하면 `true`입니다.

- 조회 한도(`INVESTIGATION_MAX_SOURCE_POINTS`)에 도달해 원본이 잘렸을 때
- 출력 한도(`INVESTIGATION_MAX_HISTORY_POINTS`)에 도달해 응답이 잘렸을 때
- `coverage_ratio`가 `INVESTIGATION_MIN_COVERAGE_RATIO`(기본 `0.95`) 미만일 때

세 번째 조건 때문에, 아무것도 잘리지 않았더라도 요청 구간의 상당 부분에 원본
데이터가 없으면 완전한 응답으로 표시하지 않습니다. 예를 들어 보존 기간이 짧은
아이템을 7일 구간으로 조회하면 `coverage_ratio`가 낮게 나오고 `partial=true`가
됩니다. RCA Writer는 이를 보고서 `limitations`에 반영해야 합니다.

## 저장소 구조

```text
.
├── src/
├── tests/
├── Dockerfile
├── docker-compose.yml
├── package.json
└── .env.example
```

클라이언트의 `ZABBIX_MCP_URL`은 이 서버의 `/mcp` 주소를 가리켜야 하며, n8n
HTTP Bearer Auth credential에는 동일한 `ZABBIX_MCP_AUTH_TOKEN`을 입력합니다.
