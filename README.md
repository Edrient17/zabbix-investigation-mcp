# Zabbix Investigation MCP

Zabbix API의 읽기 전용 데이터를 n8n AI Agent에 제공하는 독립 MCP 서버입니다.
Agent가 조사할 호스트·메트릭·시간 범위·집계 간격을 결정하고, 이 서버는 입력
검증과 Zabbix 조회, 수치 집계를 결정론적으로 수행합니다.

## 제공 도구

- `find_hosts`
- `get_incident_events`
- `get_trigger_details`
- `list_relevant_metrics`
- `get_metric_summary`
- `get_metric_history`
- `get_related_events`

Zabbix 설정 변경, 이벤트 확인 처리, 스크립트 및 원격 명령 실행 도구는 제공하지
않습니다.

## 환경 변수

```powershell
Copy-Item .env.example .env
```

필수 설정:

- `ZABBIX_URL`: `/api_jsonrpc.php`를 포함한 Zabbix API URL
- `ZABBIX_API_TOKEN`: 읽기 전용 API Token
- `ZABBIX_ALLOWED_HOST_GROUP_IDS`: 조회를 허용할 Host Group ID 목록
- `ZABBIX_MCP_AUTH_TOKEN`: MCP 클라이언트가 사용할 Bearer Token

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

토큰에는 최소 권한으로 다음 6개 메서드만 허용하면 충분합니다.

```text
host.get  event.get  trigger.get  item.get  history.get  trend.get
```

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
