# Zabbix Investigation MCP

Zabbix API의 읽기 전용 데이터를 MCP로 제공하는 독립 서버.

조사할 호스트·메트릭·시간 범위·집계 간격은 클라이언트가 정하고, 이 서버는 입력 검증·조회·수치 집계를 결정론적으로 수행한다. Zabbix 설정 변경, 이벤트 확인 처리, 스크립트·원격 명령 실행 도구는 제공하지 않는다.

---

## 1. 제공 도구

| 도구 | 용도 |
| --- | --- |
| `find_hosts` | 이름 검색 또는 `group_ids`로 그룹 내 호스트 나열. 둘 중 하나는 필수 |
| `get_incident_events` | 한 호스트의 문제·복구 이벤트. 심각도 필터 가능 |
| `get_related_events` | 같은 호스트의 인접 이벤트. 트리거 ID·태그로 좁힘 |
| `get_trigger_details` | 트리거 정의, 연관 아이템, 의존 관계 |
| `list_relevant_metrics` | 키워드로 수치 아이템을 찾아 `item_id`를 얻는 입구 |
| `get_metric_summary` | 여러 아이템의 구간 요약 (min·max·avg·first·last·변화율) |
| `get_metric_history` | 한 아이템의 구간 내 시계열 |
| `query_zabbix` | 위 도구로 표현할 수 없는 질문을 위한 `.get` 통로 (§1.3) |

`find_hosts`의 `group_ids` 경로는 질문이 호스트를 지목하지 않는 조사(정기 보고서 등)가 대상을 정하는 통로다.

### 1.1 호스트 지정 — id 또는 이름

호스트를 받는 5개 도구(`get_incident_events`, `get_related_events`, `list_relevant_metrics`, `get_metric_summary`, `get_metric_history`)는 **`host_id` 또는 `host` 중 하나**를 받는다.

```json
{ "host": "vm-java-docker-2", "time_from": "...", "time_to": "..." }
```

- `host`는 기술명·표시명 양쪽에 **정확 일치**로만 매칭한다. Zabbix의 `search`는 부분 일치라 후보를 받아 오는 데만 쓰고 비교는 서버가 한다. 그러지 않으면 `payment`를 물었는데 `payment-worker`가 답한다.
- 정확 일치가 둘 이상이면 후보를 나열한 오류를 낸다. **고르지 않는다** — 엉뚱한 호스트를 조사한 보고서는 제대로 조사한 보고서와 똑같이 읽힌다.
- 허용 그룹 검사는 id 경로와 동일하게 적용된다.

id가 필요한 이유는 서버 사정이다. `host.get`·`item.get`·`trigger.get`은 이름을 받지만 `event.get`·`history.get`은 거부한다. 어느 쪽인지는 호출자가 알 일이 아니므로 서버가 이름을 id로 바꿔서 쓴다.

### 1.2 시각은 두 가지 표기로

이벤트와 조회 구간에는 UTC(`started_at`·`recovered_at`·`window`)와 로컬 표기(`..._local`)가 함께 붙는다.

```json
{ "started_at": "2026-08-11T02:22:40.000Z",
  "started_at_local": "2026-08-11 11:22:40 (Asia/Seoul)" }
```

UTC 하나만 주면 `02:22:40Z`를 새벽 2시로 읽고 다른 도구에 `02:22+09:00`으로 넘기는 일이 생긴다. 조회는 9시간 어긋난 채 **성공하고**, 빈 결과가 "그때는 조용했다"로 읽힌다.

표기할 때는 `_local`을, 다른 도구에 넘길 때는 `Z` 쪽을 쓴다.

### 1.3 `query_zabbix` — 임의 `.get` 통로

전용 도구가 답할 수 없는 질문("이 호스트에 어떤 템플릿이 붙어 있나", "이 트리거의 원문 식은")을 위해 `.get` 메서드를 그대로 호출한다. 쓰기 메서드는 목록에 없어 도달하지 않는다.

넘겨받은 파라미터를 그대로 보내지 않고 **경계를 질의 안으로 밀어 넣는다.**

| 메서드 | 제한 방식 |
| --- | --- |
| `host.get` `hostgroup.get` `item.get` `trigger.get` `event.get` `problem.get` `graph.get` `httptest.get` | `groupids`를 허용 그룹과 교집합해서 주입 |
| `hostinterface.get` | `hostids` 필수. 호스트마다 접근 권한 확인 |
| `dashboard.get` `template.get` `usermacro.get` `auditlog.get` | 호스트에 매이지 않아 그룹 제한이 성립하지 않음 |

교집합이 비면 **오류를 낸다.** 빈 결과로 돌려주면 "그 그룹에 아무것도 없다"로 읽히고, 제한을 풀어 전체를 돌려주면 경계가 조용히 사라진다.

<details>
<summary><b>응답에 함께 오는 것</b></summary>

| 필드 | 의미 |
| --- | --- |
| `params_applied` | **받은 질의가 아니라 실제로 보낸 질의.** 그룹 주입과 별칭 치환이 반영된 결과 |
| `selects_renamed` | 별칭으로 고쳐 보낸 파라미터. `host.get`의 `selectTemplates`는 Zabbix에서 *연결된* 템플릿이 아니라 다른 뜻이라, `selectParentTemplates`로 바꿔 보내고 그 사실을 알린다 |
| `select_counts` | 한 행을 조회했을 때 `select*`로 딸려온 배열의 길이. 트리거가 몇 개인지 세려고 행을 통째로 읽고 모델이 직접 세다가 틀리는 일을 막는다 |

응답은 행 수(`INVESTIGATION_MAX_RAW_ROWS`)와 문자 수(`INVESTIGATION_MAX_RAW_RESULT_CHARS`) 양쪽으로 자른다. 모든 필드를 선택한 한 행이 좁은 백 행보다 클 수 있어 행 수만으로는 상한이 되지 않는다.

</details>

---

## 2. 환경 변수

```powershell
Copy-Item .env.example .env
```

### 2.1 필수

| 변수 | 내용 |
| --- | --- |
| `ZABBIX_URL` | `/api_jsonrpc.php`를 포함한 Zabbix API URL |
| `ZABBIX_API_TOKEN` | 읽기 전용 API Token |
| `ZABBIX_ALLOWED_HOST_GROUP_IDS` | 조회를 허용할 Host Group ID 목록 |
| `ZABBIX_MCP_AUTH_TOKEN` | MCP 클라이언트가 사용할 Bearer Token |

**`ZABBIX_ALLOWED_HOST_GROUP_IDS`를 비워 두면 토큰이 볼 수 있는 모든 호스트가 조사 대상이 된다.** 제한은 그룹 단위로만 동작하므로, 특정 호스트 몇 대만 대상으로 삼으려면 Zabbix에 전용 그룹을 만들어 그 ID 하나만 지정한다. 기존 운영 그룹을 그대로 쓰면 의도하지 않은 호스트까지 열린다.

`find_hosts`가 `group_ids`로 그룹을 지정해도 이 목록이 상한이다. 목록에 없는 그룹은 결과에서 제외되고 `excluded_group_ids`로 알려 주며, 요청한 그룹이 전부 목록 밖이면 빈 결과가 아니라 **오류**를 낸다 — 빈 결과는 "그 그룹에 호스트가 없다"로 읽히는데 그건 다른 사실이다.

토큰은 길고 무작위인 값을 쓴다.

```powershell
[Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLower()
```

### 2.2 선택

| 변수 | 기본 | 내용 |
| --- | --- | --- |
| `ZABBIX_RAW_QUERY_METHODS` | 전부 | `query_zabbix`가 제공할 메서드 목록 |
| `DEFAULT_TIMEZONE` | `Asia/Seoul` | `..._local` 표기에 쓰는 시간대 |
| `INVESTIGATION_MAX_RAW_ROWS` | `50` | `query_zabbix` 응답 행 수 상한 |
| `INVESTIGATION_MAX_RAW_RESULT_CHARS` | `12000` | 같은 응답의 문자 수 상한 |

`ZABBIX_RAW_QUERY_METHODS`에는 **Zabbix 역할이 실제로 허용하는 것만 적는다.** 역할이 거부하는 메서드를 목록에 두면 호출을 한 번 해 봐야 알 수 있고, 그 왕복은 조사 시간에서 나간다.

서버가 모르는 이름이 있으면 **기동하지 않고 오류를 낸다.** 오타 하나를 조용히 버리면 설정했다고 믿는 것보다 적은 권한으로 돌아가는데, 그 사실을 알려 주는 곳이 없다.

나머지 한도(`INVESTIGATION_MAX_WINDOW_HOURS`, `INVESTIGATION_MAX_EVENTS` 등)는 `.env.example`에 기본값과 주석으로 설명해 두었다.

## 3. 실행

```powershell
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://127.0.0.1:3000/healthz
```

| 엔드포인트 | 주소 |
| --- | --- |
| MCP | `http://<host>:3000/mcp` |
| 상태 확인 | `http://<host>:3000/healthz` |

MCP 요청 헤더:

```text
Authorization: Bearer <ZABBIX_MCP_AUTH_TOKEN>
```

### 3.1 네트워크 노출 제한

컨테이너 포트가 게시되는 호스트 인터페이스는 `MCP_BIND_ADDRESS`가 정한다.

```dotenv
MCP_BIND_ADDRESS=192.168.20.22   # 이 머신의 사설 IP
```

지정하지 않으면 `127.0.0.1`로 게시되므로, 설정을 빠뜨려도 공인 인터페이스에 열리지 않는다.

| 변수 | 무엇을 정하는가 |
| --- | --- |
| `MCP_BIND_ADDRESS` | **호스트 노출을 실제로 통제하는 값** |
| `MCP_HOST` | 프로세스 자체의 바인드 주소. compose에서는 컨테이너 내부 기준 `0.0.0.0` 고정 |
| `MCP_ALLOWED_HOSTS` | 요청의 `Host` 헤더 검사. DNS rebinding 방어용이며 네트워크 접근 제어를 대신하지 않음 |

**Docker는 자신의 forwarding 규칙을 ufw보다 앞에 삽입한다.** `0.0.0.0`으로 게시한 포트는 호스트 방화벽으로 막히지 않으므로, 방화벽에 의존하지 말고 바인드 주소를 지정한다. 클라우드 보안 그룹에서도 3000 포트를 사설 대역으로 제한하는 것을 권장한다.

적용 결과는 실행 전에 확인할 수 있다.

```powershell
docker compose config
```

```yaml
ports:
  - host_ip: 192.168.20.22
    published: "3000"
    target: 3000
```

운영 환경에서는 3000 포트를 인터넷에 그대로 공개하지 말고 HTTPS reverse proxy·방화벽·사설 네트워크를 사용한다.

## 4. 토큰 권한

Zabbix 역할(User role)의 **API methods**를 `Allow list`로 두고 필요한 메서드만 체크한다.

전용 도구 7개는 다음 6개면 동작한다.

```text
host.get  event.get  trigger.get  item.get  history.get  trend.get
```

`query_zabbix`까지 쓰려면 제공할 메서드를 역할에도 허용하고 같은 목록을 `ZABBIX_RAW_QUERY_METHODS`에 적는다. 현재 배포 조합:

```text
hostgroup.get  hostinterface.get  problem.get  graph.get
httptest.get   dashboard.get      template.get usermacro.get
```

- `auditlog.get`은 메서드 허용만으로는 부족하고 **감사 로그를 읽을 수 있는 사용자 유형**이 필요해 기본 목록에서 빠져 있다.
- 역할에는 읽기 권한만 두고, 호스트 그룹 접근은 `ZABBIX_ALLOWED_HOST_GROUP_IDS`와 **Zabbix 쪽 권한 양쪽에서** 좁힌다. 이 서버의 그룹 제한은 편의를 위한 것이지 Zabbix 권한을 대신하지 않는다.

---

## 5. 조회 구간 정책

구간 한도는 `policy` 인자로 고른다. `get_incident_events`, `get_related_events`, `get_metric_summary`가 받는다.

| `policy` | 한도 | 쓰임 |
| --- | --- | --- |
| `standard` (기본) | `INVESTIGATION_MAX_WINDOW_HOURS` (기본 `26`) | 사건 하나를 보는 조사 |
| `long_term_capacity` | `INVESTIGATION_LONG_TERM_MAX_DAYS` (기본 `400`) | 월간·연간 정기 보고서 |

한도를 넘기면 `TIME_RANGE_LIMIT_EXCEEDED`로 거절한다. **조용히 자르지 않는다** — 한 달을 물었는데 하루가 돌아오고 그 사실이 어디에도 남지 않는 것이 가장 나쁜 결과다.

- `long_term_capacity`는 메트릭 조회에서 trend 데이터를 읽으므로 1시간 이상 집계를 요구한다. 이벤트 조회는 집계를 하지 않아 이 제약을 받지 않는다.
- 400일 상한이 남아 있는 이유는 `INVESTIGATION_MAX_SOURCE_POINTS`가 양을 막아 줄 뿐 `time_from`을 잘못 적은 것은 아무도 못 잡기 때문이다.

### 5.1 이벤트 응답의 `partial`

이벤트 조회는 `limit`(기본·최대 `INVESTIGATION_MAX_EVENTS`)에서 끊긴다. 끊긴 경우 `partial: true`가 함께 오고, 그때 `result_count`는 **하한**이다. "지난달 이벤트 3건"이라고 쓰기 전에 이 값을 확인해야 한다.

## 6. 집계 정책

- 짧은 범위는 `history.get` 원시 값을 지정 간격으로 집계한다.
- 오래된 장기 범위는 `trend.get` 결과를 재집계한다.
- 결과에 `data_source`, `sample_count`, `coverage_ratio`, `partial`을 포함한다.
- 장기 조회는 최소 1시간 집계만 허용한다.
- 평균·최댓값은 이 서버가 계산한다. 클라이언트는 반환된 값을 해석만 한다.

`partial`은 다음 중 하나라도 해당하면 `true`다.

| 조건 | 의미 |
| --- | --- |
| `INVESTIGATION_MAX_SOURCE_POINTS` 도달 | 원본이 잘림 |
| `INVESTIGATION_MAX_HISTORY_POINTS` 도달 | 응답이 잘림 |
| `coverage_ratio` < `INVESTIGATION_MIN_COVERAGE_RATIO` (기본 `0.95`) | 구간 상당 부분에 원본 데이터가 없음 |

세 번째 조건 때문에, 아무것도 잘리지 않았더라도 요청 구간의 상당 부분에 데이터가 없으면 완전한 응답으로 표시하지 않는다. 예를 들어 보존 기간이 짧은 아이템을 7일 구간으로 조회하면 `coverage_ratio`가 낮게 나오고 `partial=true`가 된다. 보고서를 쓰는 쪽은 이를 한계로 반영해야 한다.

---

## 7. 로컬 개발

Node.js 20 이상.

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

### 7.1 실제 Zabbix 통합 테스트

`tests/integration/`은 실제 Zabbix API에 붙어 도구 7개와 정책 가드레일을 검증한다. 환경 변수가 없으면 자동으로 건너뛰므로 `npm test`와 CI는 Zabbix 없이도 통과한다.

Zabbix가 사설망에 있으면 먼저 터널을 연다.

```powershell
ssh -N -L 8081:<zabbix-host>:80 <jump-host>
```

```powershell
$env:ZABBIX_INTEGRATION_URL = "http://127.0.0.1:8081/zabbix/api_jsonrpc.php"
$env:ZABBIX_INTEGRATION_HOST = "<조사할 호스트 이름>"
npm run test:integration
```

- `ZABBIX_API_TOKEN`은 지정하지 않으면 저장소 `.env`에서 읽는다. 토큰을 명령줄에 노출하지 않아도 된다.
- 세 변수(`ZABBIX_INTEGRATION_URL`, `ZABBIX_API_TOKEN`, `ZABBIX_INTEGRATION_HOST`)가 모두 있어야 실행된다.
- 대상 호스트에 이벤트가 없으면 이벤트 관련 단정은 건너뛰고 나머지 계약과 가드레일은 그대로 검증한다.

## 8. 저장소 구조

```text
.
├── src/
├── tests/
├── Dockerfile
├── docker-compose.yml
├── package.json
└── .env.example
```

이 서버는 클라이언트의 소스를 참조하지 않는다. 연결 계약은 MCP 도구 스키마와, 클라이언트가 설정하는 `/mcp` 주소·Bearer 토큰뿐이다.
