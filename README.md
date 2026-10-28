# TrafficReplay

React + TypeScript + ECharts 前端。页面数据来自配置的 Prometheus 与 Benchmark 服务。

右上角“中文 / EN”按钮切换中英文，默认中文并记住语言选择。界面、图例、任务状态和弹窗随语言切换；语言切换不重新查询指标、不重置模型/选区/回放任务，时间始终按 Asia/Shanghai 展示。上游返回的错误详情和模型名称保留原文。

## 正式历史与灰度回放指标分离（2026-10-27）

历史模型发现、左侧负载曲线和原有延迟卡片查询正式指标后端；回放负载、回放实时延迟、TTFT 趋势、缓存观测查询灰度 Prometheus。回放 Token 吞吐默认跟随灰度，也可独立配置为正式指标入口。目标模型在单个 Prometheus 内能唯一定位部署时，继续仅按真实 `model_name` 筛选，无需增加 namespace/environment/deployment。

本次只改本仓库，不修改 Benchmark。`/api/models` 和 `/api/replays` 仍走原 Benchmark；新增同源 `/api/replay-prometheus/query`、`query_range` 由 Vite 或本项目容器 Nginx **直接**代理至灰度 Prometheus 的 `/api/v1/query`、`query_range`，原样保留 PromQL、start/end/step/time。支持 Prometheus 部署在 URL 子路径。浏览器不直接访问跨域 Prometheus，也不保存它的真实地址或凭据。

在前端项目的 `.env.local`（本地）或 `.env`（Docker Compose）配置：

```dotenv
# 现有正式指标后端，保留原值；这里不是 Prometheus 地址。
BACKEND_URL=http://<PROD_METRICS_BACKEND>:<PORT>
# 现有 Benchmark 地址，保留原值。
REPLAY_BACKEND_URL=http://<BENCHMARK_HOST>:<PORT>
# 灰度 Prometheus 实际基地址；不追加 /api/v1/query。
REPLAY_PROMETHEUS_URL=http://<GRAY_PROMETHEUS_HOST>:9090
VITE_PROMETHEUS_API_PREFIX=/api/prometheus
VITE_REPLAY_PROMETHEUS_API_PREFIX=/api/replay-prometheus
# 正式历史档案别名、灰度目标别名分别映射；名称与指标一致时使用空对象。
VITE_MODEL_METRICS_MAP='{}'
VITE_REPLAY_MODEL_METRICS_MAP='{}'
# 留空则吞吐查询灰度；LiteLLM 只被正式采集时填 /api/prometheus。
VITE_REPLAY_THROUGHPUT_PROMETHEUS_API_PREFIX=
# 灰度上游若需要 Bearer 认证，填原始 token，不加 Bearer；否则留空。
REPLAY_PROMETHEUS_BEARER_TOKEN=
```

Prometheus 基地址须可由前端服务/容器访问；容器中的 localhost 指容器自身。`REPLAY_PROMETHEUS_URL` 和 `REPLAY_PROMETHEUS_BEARER_TOKEN` 是服务端变量，不能改成 `VITE_` 前缀。灰度代理清除浏览器提交的 Authorization/x-api-key/x-litellm-key，仅按独立的服务端 token 配置灰度上游认证；现有页面指标认证继续用于正式指标后端。

本地修改后重启 `npm run dev`；Docker Compose 修改后执行 `docker compose up -d --build`，因为 `VITE_` 路径属于构建配置。如果仅更换灰度地址或 token，无需重新构建前端，可执行 `docker compose up -d` 重建容器配置。自行托管 dist 时，必须同时部署等价的 Nginx 路由；Vite 配置不会改变外部服务器。

容器默认启用双指标入口；旧环境直接构建且未设置 `VITE_REPLAY_PROMETHEUS_API_PREFIX` 时保留单指标源兼容。若要在 Compose 中使用单源，显式设 `VITE_REPLAY_PROMETHEUS_API_PREFIX=/api/prometheus`，并清空 `REPLAY_PROMETHEUS_URL`。双源配置下灰度地址未填会明确返回 503；不自动回退正式指标源。前端缓存按完整 URL 隔离，限流按指标入口隔离，灰度 429 不阻断正式历史查询。刷新恢复的任务仍使用固定的回放入口和原任务时间。

`VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS` 用于回放观测，应填写灰度 vLLM 实际采集间隔；负载曲线终态尾部为两次采集间隔，之后再等待 30 秒缓存余量，并取得在余量结束后发起的成功查询才停止。吞吐可通过 `VITE_REPLAY_THROUGHPUT_CONFIG.scrapeSeconds` 单独配置。正式与灰度若实际指标名不同，需先统一当前使用的指标定义或另行扩展指标名配置；此次分流沿用现有指标表达式。

再次审查修复（2026-10-27）：历史和目标别名改为分别配置，避免两边同名指标使灰度目标别名反向污染正式 `source_model`；刷新恢复历史也不借用灰度目标的指标标签。取消响应同样应用目标映射，避免终态改用 LiteLLM 别名而查不到尾部。负载补采随灰度采集间隔变化；负载、延迟和缓存都按请求发起时间判断是否能够停止，并在最终补采时绕过截止时间之前的前端缓存，避免慢查询或机器休眠造成提前停止。Vite 在配置灰度地址却遗漏回放路径时明确拒绝启动，避免页面仍静默使用正式入口。

### Benchmark 对接与修改说明

已按 `D:\ai_workspace\Benchmark` 当前代码复核，本次 Benchmark **代码修改清单为空，新增接口和配置均为零**，无需为指标分源重建或重启 Benchmark。它继续读取正式请求档案，经原 `LITELLM_URL` 向所选 `target_model` 发流；指标查询由看板服务直接代理，不经过 Benchmark。`REPLAY_PROMETHEUS_URL` 等新增配置全部放在本前端项目中。

本次前端项目的修改位置：

| 文件 | 改动 |
| --- | --- |
| `src/apiConfig.ts`、`src/App.tsx` | 拆分历史、回放、LiteLLM 吞吐三份指标配置及历史/目标别名映射；历史恢复不借用目标标签，连接设置显示实际入口 |
| `src/data.ts` | 按指标入口隔离 429 退避；原完整 URL 缓存继续区分正式和灰度 |
| `src/replay.ts`、`src/useReplay.ts` | 创建、状态与取消响应统一使用目标别名映射 |
| `src/replayLatencyData.ts`、`src/ReplayLatency.tsx`、`src/ReplayCache.tsx`、`src/replayCacheData.ts` | 补采尾部跟随实际采集间隔，最终查询按发起时间判断且绕过过早缓存 |
| `vite.config.mjs` | 开发和预览增加灰度原生 API 代理；独立上游认证，缺少灰度地址返回 503 |
| `docker/nginx/default.conf.template`、`docker/nginx/15-generate-default-conf.sh` | 生产容器增加两个灰度指标精确路由，保留查询参数；导出模板变量使启动脚本计算出的配置生效 |
| `Dockerfile`、`docker-compose.yml`、`.env.example` | 增加构建/运行配置，Compose 同时传入前端模型别名映射；密钥与实际灰度地址仅在代理端使用 |
| `tests/metrics-sources.test.ts`、`scripts/*metrics*-check.cjs`、`scripts/proxy-check.cjs` | 验证分源、缓存/限流隔离、路由改写、全部回放组件、恢复与失败行为 |

| 现有 Benchmark 接口/字段 | 本次如何对接 |
| --- | --- |
| `GET /api/models` → `target_models: string[]` | 继续作为打流目标列表；当前服务从 LiteLLM `/v1/models` 读取，无需改为从 Prometheus 发现模型 |
| `POST /api/replays` | 保持 `source_model`、`target_model`、`start_time`、`end_time`、`speed` 五字段请求及 `Idempotency-Key`；不增加环境、Prometheus 地址或目标 IP |
| 创建响应的 `replay_id` | 用原任务 ID 继续查询状态，不额外创建观测任务 |
| `GET /api/replays/{id}?view=status`、`GET /api/replays/active?view=status` | 保持状态查询与刷新恢复；当前后端忽略 `view=status`、返回完整结果也兼容，轻量化不是本次分源的前置条件 |
| `started_at`、`finished_at` | 继续决定回放指标的真实时间窗口，与来源的历史时间区间分开 |
| `target.metrics_labels.model_name` | 当前后端返回 `target_model`；与 vLLM 标签同名时直接使用，不同名时由下述前端配置映射 |
| 任务 Bearer 认证 | 保持原认证方式；它与灰度 Prometheus 的上游认证分别配置 |

正式请求档案和灰度模型路由都已配置可达时，原 Benchmark `.env` 保持不变。若目标列表缺少灰度模型，先检查它所连接的 LiteLLM 是否配置对应灰度路由；修改 Prometheus 查询地址不会改变打流去向，也不会给 Benchmark 增加可用模型。

例如目标列表返回 `qwen-gray-service`，灰度 Prometheus 的实际 `model_name` 为 `Qwen3-32B-gray`，只需在前端配置：

```dotenv
VITE_REPLAY_MODEL_METRICS_MAP='{"qwen-gray-service":"Qwen3-32B-gray"}'
```

创建任务仍提交 `target_model: "qwen-gray-service"`，回放观测筛选 `model_name="Qwen3-32B-gray"`。映射在创建、轮询、取消和刷新恢复时均生效；Docker Compose 已传入对应构建参数，改后需重新构建。`VITE_MODEL_METRICS_MAP` 单独用于正式历史档案别名，不能把仅属于灰度的目标映射放入其中；多个灰度目标可映射到同一灰度指标名。留空或不配置 `VITE_REPLAY_MODEL_METRICS_MAP` 时继承旧的共享映射以兼容老部署，双源部署建议明确配置，目标与指标同名时填 `{}`。正式历史来源名已与档案一致时，历史映射同样填 `{}`。LiteLLM Token 吞吐使用独立的 `VITE_REPLAY_THROUGHPUT_CONFIG.targets` 映射，不自动使用 vLLM 的 `model_name`。

如果服务器上实际运行的是更旧的 Benchmark，仅支持单个 `model_id`、不接受独立的 `source_model`/`target_model`，才需要补齐来源到目标的回放能力：在 `app/benchmark/api.py` 解析并保存双模型字段，将二者分别传给 `prepare_and_run`；在 `app/benchmark/core.py` 按来源检索档案、按目标发送请求；创建、状态及活动响应返回固定的双模型和时间区间，幂等指纹包含双模型。旧版调用可保留 `model_id` 同时作为来源与目标的兼容分支。当前提供的 Benchmark 已具备这些能力，因此本次没有执行此类修改，也不需要新增 Prometheus 接口。现有 README 中关于轻量状态、版本号等旧缺口说明不代表它们是本次改造的必需项。

### 生产部署与对接验收

使用本项目 Docker Compose 时，新增代理随镜像一起部署；自行托管 `dist/` 时，需要在已有 Nginx `server` 中增加下面两个精确路由，替换示例上游地址。保留原正式 `/api/prometheus/*` 和 Benchmark `/api/models`、`/api/replays/*` 路由。

```nginx
location = /api/replay-prometheus/query {
    proxy_pass http://GRAY_PROMETHEUS_HOST:9090/api/v1/query;
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_read_timeout 310s;
    proxy_set_header Authorization "";
    proxy_set_header x-api-key "";
    proxy_set_header x-litellm-key "";
}

location = /api/replay-prometheus/query_range {
    proxy_pass http://GRAY_PROMETHEUS_HOST:9090/api/v1/query_range;
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_read_timeout 310s;
    proxy_set_header Authorization "";
    proxy_set_header x-api-key "";
    proxy_set_header x-litellm-key "";
}
```

这两个 `proxy_pass` 保留原查询参数。若灰度 Prometheus 需要 Bearer 认证，两个块中的 Authorization 改为服务端受控配置的 `Bearer <实际灰度凭据>`；不要填写 Benchmark 密钥。外部 Nginx 不会自动读取本项目 `.env`；使用本项目容器才会自动替换上游和凭据。配置完成后执行 `nginx -t` 并重新加载；本项目容器可用 `docker compose exec dashboard nginx -t` 检查。

1. 从看板服务所在机器/容器确认能访问灰度 Prometheus；浏览器只需要访问看板同源地址。
2. 检查正式 `/api/prometheus/query` 和灰度 `/api/replay-prometheus/query`：用 `count by (model_name) (vllm:num_requests_running)` 确认分别返回预期模型。两边存在部分同名模型正常，单个入口内的目标部署须明确。
3. 页面连接设置应显示历史入口 `/api/prometheus`、回放入口 `/api/replay-prometheus`；Token 吞吐入口按实际 LiteLLM 采集位置配置。
4. 创建回放后在浏览器 Network 确认：任务仍发往 Benchmark 的同源路由，历史负载和原有延迟卡查正式入口，回放负载、五项回放延迟、TTFT 趋势和缓存查灰度入口；回放查询使用任务的实际起止时间。
5. 刷新页面，确认恢复同一任务，右侧继续查灰度，切换左侧模型不改变右侧目标。Token 吞吐应查询实际采集它的指标源。
6. 灰度返回错误时，应在回放区域显示错误，正式历史仍能查询；不会把正式指标作为灰度结果展示。回放刚开始时延迟/趋势可能等待足够的采样窗口，空结果不代表任务未发流。

需要回退为旧单源模式时，将 `VITE_REPLAY_PROMETHEUS_API_PREFIX=/api/prometheus`，清空 `REPLAY_PROMETHEUS_URL` 和 `VITE_REPLAY_THROUGHPUT_PROMETHEUS_API_PREFIX`，重新构建部署前端即可；Benchmark 继续使用原配置。

验证：`npm test`、`npm run build`、`node scripts/proxy-check.cjs`、`node scripts/nginx-metrics-check.cjs`、`node scripts/metrics-sources-check.cjs`。代理测试仅访问本机模拟上游；浏览器测试构建独立产物并拦截全部 API，覆盖同名模型分源、全部回放观测、原五字段请求、刷新恢复、灰度失败无回退、凭据不进入产物及 320px 布局，不发送实际回放流量。当前 Windows 环境无 Docker/Nginx，已验证启动脚本生成的配置，尚未运行容器内 `nginx -t` 或真实双环境联调。

本次审查结果：87 项单元测试、生产构建、代理与 Nginx 配置生成检查通过；浏览器补充验证独立的历史/灰度目标别名、同名指标、无本地快照的活动恢复、60 秒灰度采集和查询途中系统时间跳变，确认最终观测会重新补查。Benchmark 工作目录保持无改动。

## 来源模型与打流目标分离（2026-10-26）

新建回放不再发送单个 `model_id`，改为 `source_model`、`target_model`、`start_time`、`end_time`、`speed` 五个字段。当前“查询模型”下拉框仍决定历史来源；在左侧回放时间区域点击新增的“选择目标”按钮，从 Benchmark 的 `GET /api/models` 响应 `target_models` 中选择要打流的 LiteLLM 模型。列表支持搜索、刷新、错误重试和空列表提示，加载列表失败或没有有效目标时不能开始回放。

```json
{
  "source_model": "archive-model-a",
  "target_model": "litellm-model-b",
  "start_time": 1792972800,
  "end_time": 1792973400,
  "speed": 1
}
```

来源默认取下拉框选中值；配置了唯一的 `VITE_MODEL_METRICS_MAP` 别名时，沿用原有 `replayModelId || model.id` 逻辑提交档案模型名。目标严格使用 `target_models` 返回的模型 ID，可与来源相同。Benchmark 已原生接受 `source_model` / `target_model`，按来源检索 SpendLogs/JSONL 并将请求发送到目标，本次无需修改 Benchmark。

确认弹窗分别展示来源和目标，右侧以“来源 → 目标”展示固定的任务上下文。切换查询模型不会改变已有任务；回放负载、实时延迟、历史趋势和缓存观测都使用目标指标标签，LiteLLM 吞吐映射按 `target_model` 查找。后端返回的 `target.metrics_labels` 优先；当前 Benchmark 将目标别名直接返回为 `model_name` 时，使用 `VITE_REPLAY_MODEL_METRICS_MAP` 映射到实际 vLLM 标签；未配置时兼容旧的共享映射。

新任务快照保存来源显示名及来源指标名，刷新后分别恢复历史与目标观测。旧任务响应中的 `model_id` 继续兼容读取；旧的待确认创建请求保留其原始请求体、签名和幂等键，重试时不自动转换字段。新建请求的来源和目标都进入幂等签名。保存的目标偏好需重新打开选择器核对最新可用列表后才能用于新建任务。

Vite 开发/预览与容器 Nginx 均将 `/api/models` 分流到 `REPLAY_BACKEND_URL`，未配置时回落 `BACKEND_URL`；正式指标继续走指标后端，灰度指标按上节直连代理配置。模型列表按当前 Benchmark 契约不携带回放/指标凭据，`proxy` 认证注入仍只用于回放任务路由。自行维护生产反向代理时，同样需要增加 `/api/models` 到 Benchmark 的精确路由。

主要改动：`src/App.tsx`（目标选择与双模型请求/展示）、`src/data.ts`（目标列表校验和请求）、`src/replay.ts` / `src/replayStorage.ts`（恢复与旧记录兼容）、`src/types.ts`、`src/i18n.ts`、`src/styles.css`，以及 Vite/Nginx 分流配置。接口说明见 [流量回放接口文档](docs/replay-api.md)。

验证：`npm test`、`npm run build`、`node scripts/proxy-check.cjs`；启动本地 4173 预览服务后运行 `node scripts/replay-target-check.cjs`、`node scripts/backend-check.cjs`、`node scripts/replay-recovery-check.cjs`。浏览器检查全部拦截 API，覆盖 A → B、五字段请求、目标指标标签、来源/目标刷新恢复、搜索、空/失败/格式错误列表、中英文和 320px 布局，不发送真实推理流量。

前端回放任务、指标图表和模型列表均读取配置的后端服务；仓库中的自动化脚本使用模拟 HTTP 响应，不会发送真实推理流量。

这是纯前端工程，不包含看板后端、请求档案、回放调度器或 Prometheus/vLLM/LiteLLM 服务。Vite 仅用于本地开发、构建和预览，以及将本地 API 请求代理到已有看板后端。GitHub 保存源码，不会代替后端执行流量回放。

回放后端对接请参阅 [流量回放接口文档](docs/replay-api.md)，其中列出创建任务、完整状态响应、幂等语义和前端观测流程。

页面时间统一按 Asia/Shanghai 显示，时间输入按 UTC+08:00 转换为 Unix 秒级时间戳，不依赖浏览器时区。历史查询支持 15 分钟、30 分钟、1 小时、6 小时、12 小时、24 小时、7 天，可配合截止时间查询更早的区间。各范围保持约 60 个点；7 天的查询步长为 10080 秒。跨日图表显示日期与时间。真实数据覆盖范围取决于 Prometheus 保留时间，请求回放覆盖范围取决于后端请求档案。

## 数据来源与流向

```text
模型列表：正式 vLLM /metrics → 正式 Prometheus
        → 看板后端 /api/prometheus/query（count by (model_name)）
        → data.ts / fetchModels / parseModelVector → App.models → 模型下拉框

历史曲线：正式 vLLM /metrics → 正式 Prometheus → 看板后端 /api/prometheus/query_range
                      → data.ts / parseMatrix → App.history → 左侧 LoadChart

即时卡片：正式 Prometheus → 看板后端 /api/prometheus/query
                   → data.ts / parseLatencyVector → App.metrics → TTFT/E2E/ITL/TPOT/QT 五张卡

回放延迟：任务实际时间、目标模型标签 → /api/replay-prometheus/query → 灰度 Prometheus
        → ReplayLatency → 独立五张回放实时延迟卡片（短窗口，每 30s 更新）
        → ReplayTrend → 首 Token 延迟历史趋势（完整 rate 窗口，每 30s 更新）

回放缓存：同一任务的时间、目标标签 → /api/replay-prometheus/query_range → 灰度 Prometheus
        → replayCacheData / ReplayCache / CacheTrend → 三张卡片与三张趋势图

创建回放：左侧刷选 / 时间输入 → App.selection
        + 选择目标 → Benchmark /api/models 的 target_models
        → POST /api/replays { source_model, target_model, start_time, end_time, speed }
        → 后端检索来源档案并向所选目标发送 → 返回 replay_id → App.replay

回放观测：GET /api/replays/{id} → 实际开始/结束时间、状态、目标指标标签
        → data.ts / fetchLoad → /api/replay-prometheus/query_range → 灰度 Prometheus
        → App.replayData → 右侧 LoadChart
```

以上按双源模式展示；未配置独立回放前缀的旧单源模式仍使用 `/api/prometheus`。

请求 ID 和完整请求内容不经过折线组件；任务完成由后端状态接口决定，不能从曲线是否归零推断。模型下拉框切换只影响左侧查询，右侧任务使用创建时固定的模型。所有接口时间使用 Unix 秒，图表绝对轴转换为毫秒，相对轴转换为距实际开始时间的秒数。

| 文件 | 数据相关职责 |
|---|---|
| src/data.ts | 接口调用、缓存/限流、PromQL、原样 JSON 解析 |
| src/apiConfig.ts | 接口路径、指标名称、回放逻辑别名与 vLLM 模型标签的显式映射 |
| src/App.tsx | 查询条件、历史选区、回放提交、状态轮询与两个窗口的数据分配 |
| src/types.ts | 模型 ID、指标标签、数据类型及时间单位约定 |
| src/LoadChart.tsx | 绘制、异常值断点、tooltip、刷选边界回传，不发 HTTP 请求 |
| src/replayCacheData.ts、src/ReplayCache.tsx、src/CacheTrend.tsx | 回放缓存配置/查询、实例解析、独立轮询、指标卡与缓存趋势图 |
| src/replayTrendData.ts、src/ReplayTrend.tsx | 回放首 Token 延迟趋势查询、轮询、解析与图表 |
| src/chartTime.ts、src/time.ts | Unix 秒与图表坐标、相对时间、上海时间输入/显示之间的转换 |
| vite.config.mjs | 本地同源请求到看板后端的代理 |

模型与历史曲线通过 Prometheus 获取；回放状态和进度通过 Benchmark 获取。

## 启动

建议安装 Node.js 22 LTS 和 Git。仓库提交 package-lock.json，其他电脑使用 npm ci 安装相同依赖。

```sh
npm ci
npm run dev
```

构建：`npm run build`。解析测试：`npm test`。

`npm run dev` 先构建再启动本地预览，兼容受限 Windows 环境；修改代码后需重新执行。普通本地环境可使用 `npm run dev:source` 启动 Vite 源码开发服务。

本地预览地址为 http://127.0.0.1:5173/。不要通过双击 index.html 启动页面。

## 上传到 GitHub

以 llm-dashboard 目录为仓库根目录，上传 src/、tests/、scripts/、index.html、package.json、package-lock.json、tsconfig.json、vite.config.mjs、README.md、.gitignore 和 .env.example。

不要上传 node_modules/、dist/、*.tsbuildinfo、真实 .env 配置、日志和生成的预览截图；.gitignore 已排除这些文件。package-lock.json 和 .env.example 应保留。截图可以之后单独整理到文档目录。

在 GitHub 新建空仓库 TrafficReplay，先不要自动添加 README、.gitignore 或 License。在本机 PowerShell 中执行：

```powershell
Set-Location 'D:\ai_workspace\llm-dashboard'
git init
git add .
git status --short
git diff --cached --stat
git commit -m "Initial TrafficReplay frontend"
git branch -M main
git remote add origin https://github.com/<GITHUB_USER>/TrafficReplay.git
git push -u origin main
```

将 <GITHUB_USER> 替换为账号或组织。git status 中确认没有 node_modules、dist 或真实环境配置。如果 Git 提示身份未配置，先在该仓库执行 `git config user.name "你的名字"` 和 `git config user.email "你的邮箱"`，再提交。推送时使用已登录的 GitHub 凭据或凭据管理器，不在命令中嵌入访问令牌。

## 另一台电脑拉取并对接

安装 Node.js 22 LTS 与 Git 后执行：

```sh
git clone https://github.com/<GITHUB_USER>/TrafficReplay.git
cd TrafficReplay
npm ci
```

复制环境模板。Windows PowerShell：

```powershell
Copy-Item .env.example .env.local
```

macOS/Linux：

```sh
cp .env.example .env.local
```

编辑 .env.local：

```dotenv
BACKEND_URL=http://<BACKEND_IP>:<BACKEND_PORT>
REPLAY_BACKEND_URL=http://<BENCHMARK_IP>:<BENCHMARK_PORT>
VITE_PROMETHEUS_API_PREFIX=/api/prometheus
VITE_MODEL_METRICS_MAP='{}'
VITE_REPLAY_CREATE_PATH=/api/replays
VITE_REPLAY_STATUS_PATH=/api/replays/{id}
```

`BACKEND_URL` 填写已有指标后端地址，`REPLAY_BACKEND_URL` 可选，填写独立 Benchmark 后端地址；留空时回放仍走 `BACKEND_URL`。地址不是 Prometheus、LiteLLM 或 vLLM 地址。后端位于其他机器时，不应填写 127.0.0.1。修改连接配置后重启 `npm run dev`。页面选择“后端”，先确认 Prometheus 模型列表与历史指标。连接设置默认选择 `Authorization`；接入 Benchmark 时，认证值填写 `Bearer ` 加服务端 `BENCHMARK_API_KEY` 的实际值，不带尖括号，页面不会自动补前缀。模型列表和指标查询不携带该凭据。

后续同步源码：`git pull`、`npm ci`，然后重新启动。自己的 .env.local 不进入 Git，因此不会被其他电脑的连接配置替换。

scripts/test.cjs 支持 npm test；浏览器检查脚本目前默认使用 Windows Chrome 路径和 4173 端口，其他电脑运行这些可选检查前需要按实际浏览器与预览端口调整。日常启动页面不依赖这些脚本。

## 后端连接

将 `.env.example` 复制为 `.env.local`，配置 `BACKEND_URL=http://<BACKEND_IP>:<BACKEND_PORT>`，重启服务。独立 Benchmark 可另外配置 `REPLAY_BACKEND_URL`；Vite 开发和预览会优先将创建/状态路径转发给 Benchmark，其余 `/api` 请求仍走已有看板后端，自定义回放路径也支持分流。回放认证值在右上角设置中输入，只保存在内存中。静态生产部署需在反向代理中配置相同的路径分流；这两个地址仅用于本地代理，不进入浏览器构建产物。

任务创建响应会立即显示进度，活动任务在每次状态响应结束后约 2 秒再次查询；查询失败时保留上次计数和更新时间，并按 5、10、20、30 秒退避，429 按 Retry-After 退避，未提供时等待 60 秒。页面隐藏时暂停，恢复前台后立即尝试刷新；终态立即停止状态轮询。右侧曲线独立每 30 秒刷新，较慢的指标查询不会阻塞进度。

回放观测的模型名称下方显示“已完成 / 总请求”、百分比和进度条，以及已发送、失败、跳过数量与最近成功接收时间。计数优先读取 `progress.total/completed/sent`，兼容顶层 `request_count/completed_count/sent_count`。总数未知时显示统计中，已知但尚未打流时显示 `0 / 总数`；没有可回放请求时不将 `0 / 0` 显示为 100%。已完成包含处理结束的失败请求，100% 不代表全部成功；任务结果以终态为准。

`BACKEND_URL` 用于 Vite 本地代理，不会将后端地址写入生产页面。生产部署需将 `npm run build` 生成的 dist/ 放到静态服务，并配置 `/api` 反向代理；不能只把 dist/ 放到 GitHub Pages 后期望其自动连接后端。

模型列表和即时卡片使用 `/api/prometheus/query`，负载曲线使用 `/api/prometheus/query_range`。Prometheus 前缀可通过 `VITE_PROMETHEUS_API_PREFIX` 配置；均使用以 `/api/` 开头的同源路径。旧的 `VITE_MODEL_INFO_PATH` 仅保留兼容配置，首页已不调用 LiteLLM 模型列表接口。指标按 30 秒刷新，隐藏页面暂停；历史截止时间固定后不自动刷新。同一 Prometheus URL 在前端缓存并去重 30 秒，429 按 Retry-After 退避，未提供时等待 60 秒；指标与回放分别退避。不同指标查询使用 allSettled 隔离失败，保留 NaN 和 Inf。

首页五张延迟卡片 TTFT、E2E、ITL、TPOT、QT 都使用即时 `GET /api/prometheus/query`，每张卡独立发送一条 PromQL。TTFT/E2E/ITL/QT 使用 rate(_sum)/rate(_count)；TPOT 使用解码耗时率除以生成 token 率减请求率，减法置于分母括号内。各表达式未加外层 avg。响应中的同模型 engine 分片在前端求算术平均，空闲分片的 NaN 会被跳过；如果所有分片都是 NaN，仍保留真实 NaN。普通模型按 role 分行；DeepSeek 默认把 proxy、prefill、decode 的全部分片混合平均并只展示一行，模型片段可通过 VITE_MIXED_LATENCY_ROLE_MODELS 配置。单条已聚合的结果直接取值，Inf 保留。表达式内核为 `rate(<metric>_sum{model_name="当前模型"}[<历史范围>]) / rate(<metric>_count{model_name="当前模型"}[<历史范围>])`；例如选择 12 小时，窗口就是 `[12h]`。后端接收完整 query，在看板后端的 TTL 缓存中按 URL 缓存，再请求 `${PROMETHEUS_TARGET}/api/v1/query`。因此这些卡片没有值时，应先看 Network 中的 query、HTTP 响应和 `data.result`，再区分路由错误、指标名错误、模型标签不匹配和窗口内没有样本。

原有卡片的评估时刻是现在，修改历史截止时间不会把即时 query 的评估时刻移到过去；它只调整左侧 query_range。拖拽回放子区间也不改变原有延迟卡的回溯长度。模型或历史范围切换时清空旧卡片并重新查询，旧模型尚未完成的响应不会覆盖新模型数据。历史曲线与即时卡片并发加载，卡片独立显示加载、空样本、NaN 和可展开的查询错误。历史查询刷新共发 2 条区间曲线和 5 条即时指标请求；回放开始并有足够采集时间后，新增区域另发 5 条独立延迟请求。首次模型发现另发 1 条，页面每 30 秒刷新指标。模型列表通过“刷新列表”按钮更新，同样受 30 秒缓存限制，不持续轮询。

默认指标名已按旧看板提供的表达式配置：TTFT `vllm:time_to_first_token_seconds`、E2E `vllm:e2e_request_latency_seconds`、ITL `vllm:inter_token_latency_seconds`、QT `vllm:request_queue_time_seconds`。TPOT 为 `rate(vllm:request_decode_time_seconds_sum[窗口]) / (rate(vllm:request_generation_tokens_sum[窗口]) - rate(vllm:request_generation_tokens_count[窗口]))`，五项均附加当前模型筛选。分母为 0 时保留 Prometheus 返回的 NaN/Inf，不替换为 0。

例如部署的 ITL 名称为其他指标时，在 .env.local 中配置 `VITE_PROMETHEUS_METRIC_NAMES='{"itl":{"sum":"custom:itl_sum","count":"custom:itl_count"}}'`，修改后重新构建。示例中的 custom 名称仅说明格式，不能直接用于真实部署。TPOT 覆盖配置必须包含 decodeSum、generationTokensSum、generationTokensCount 三个完整指标名，例如 `{"tpot":{"decodeSum":"vllm:request_decode_time_seconds_sum","generationTokensSum":"vllm:request_generation_tokens_sum","generationTokensCount":"vllm:request_generation_tokens_count"}}`。

### 手动清空回放数据（2026-10-16）

右侧“回放观测”标题栏新增“清空数据”。仅已完成、失败、已取消的任务可以清空；等待开始、准备请求、回放中、等待处理完成、正在取消，以及创建中、恢复中、恢复失败和创建结果待确认时均禁用，悬停按钮可查看原因。

后端模式清空前会重新查询活动任务接口：发现活动任务时恢复该任务观测并拒绝清空，查询失败或响应无效时保留当前数据。清空成功后移除当前环境的本地任务快照，右侧任务信息、进度、负载曲线与关联的回放延迟/趋势/吞吐/缓存数据回到空态，停止任务轮询并忽略迟到响应；刷新且没有新的活动任务时保持空态。保留左侧历史查询、选区、语言与连接设置，不删除后端任务或 Prometheus 数据，也不丢弃未确认创建请求的幂等记录。浏览器存储清理失败时显示错误并保留页面数据。

验证：`npm test`、`npm run build`；预览服务启动后运行 `node scripts/replay-clear-check.cjs`（可设置 `CHECK_BASE_URL`）。该脚本拦截全部 API，覆盖三种终态、六种非终态、活动任务复核及失败、存储失败、幂等记录、迟到响应、停止轮询、刷新空态、重新创建、中英文与 320px 布局，不发送真实回放流量。

### 独立的回放实时延迟（2026-10-15）

底部新增一组 TTFT、E2E、ITL、TPOT、QT；原有“延迟数据”的查询模型、历史回溯窗口和刷新规则保持原样。新区域使用右侧任务的 `metricsName` / `target.metrics_labels`，显示任务 ID、完整来源历史区间和每项成功查询的观测时间；切换左侧模型或固定历史截止时间不会改变回放延迟的目标和轮询。

“实时”表示目标部署的近期平均延迟，每 30 秒刷新，不表示最近一条请求的延迟。默认 `VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS=15`、`VITE_REPLAY_LATENCY_WINDOW_SECONDS=60`；应将前者改为真实采集间隔，窗口自动取配置值与采集间隔 4 倍中的较大值。开始后先等待至少两次采集间隔，初期使用不越过 `started_at` 的较短窗口，再逐步增长到配置窗口。无样本、NaN、Inf 保留原意，不替换成 0；低流量时短窗口可能没有有效延迟数据。修改配置后重新构建。

查询仍走已有 `/api/prometheus/query?query=...`，例如 `rate(vllm:time_to_first_token_seconds_sum{model_name="目标模型"}[1m] @ 观测Unix秒) / rate(vllm:time_to_first_token_seconds_count{model_name="目标模型"}[1m] @ 观测Unix秒)`。指标后端只需原样透传完整 query，缓存键包含完整 query；无需新增接口或额外透传 `time` 参数。Prometheus 必须支持并启用范围选择器的 `@` 修饰符，且保留对应时刻的指标。各项指标应存在与右侧曲线相同的真实部署标签；不存在的指标或标签会返回空值或错误。

未创建/未打流时显示等待，不查询回放延迟；等待在途请求完成和取消过程中仍持续观测。任务终态后将最终观测时间固定为 `finished_at + 2 × 采集间隔`，等待额外 30 秒缓存余量并取得一轮无查询错误的结果后停止轮询，成功空结果也属于一次成功查询，不能据此证明样本完整。结束后的数值是该固定窗口的近期平均，不是整个任务的平均。失败项保留本任务最近成功值及时间，并明确标记查询失败；新任务或目标部署变化会清空旧值。顶部“刷新指标”也刷新新增区域。

刷新页面先沿用现有任务恢复机制，再重新查询回放延迟；终态任务按同一固定时刻查询，不会误用刷新当天的延迟。

### 回放历史趋势（2026-10-16）

“回放历史趋势”位于回放实时延迟卡片下方，展示全宽“首 Token 延迟”曲线（TTFT，ms），其下独立展示 Token 吞吐率趋势。曲线默认使用相对时间，零点为任务实际 `started_at`；取消相对时间后显示上海时间，tooltip 同时保留完整时间和单位。区域每 30 秒刷新，任务切换或部署标签变化时清空旧曲线并忽略旧目标的迟到响应，刷新页面后按已保存任务的原始时间重新查询。

TTFT 每轮一条 `/api/prometheus/query_range`，不新增 Benchmark 接口。TTFT 复用现有延迟卡片的 histogram 配置和表达式，结果乘以 1000 显示毫秒；展示窗口平均值，普通模型按 role 分组并平均 engine，DeepSeek 等配置的模型混合 role。单个空闲 engine 的 NaN 不参与平均，全部缺失、NaN 或无穷值显示为空点；接口省略的中间采样点也会补为空点，避免折线跨过停采区间。无效响应、重复时间戳、查询网格外的点和负延迟均显示查询错误。

趋势只在完整 rate 窗口可用后开始查询，窗口左端为 `ceil(started_at + 窗口)`，不会把回放开始前的流量带入。窗口默认 60 秒，并自动保持为采集间隔的至少 4 倍；采集中显示“等待完整统计窗口”，已结束且补采时段仍不足窗口的任务显示“任务观测时段不足完整统计窗口”并停止等待。等待期间相对横轴也从实际打流的 0 秒开始。终态沿用回放延迟的固定结束时间和 30 秒缓存余量，单项查询失败保留该项最近成功曲线，成功空结果清空旧曲线。指标属于目标部署，可能包含其他业务流量；严格的任务级隔离仍需要专用部署或后端任务级指标。

最终观测时间向上取整到 Unix 整秒。首次查询失败显示“查询失败 · 查看详情”，已有成功结果后的失败保留曲线和观测时间。趋势测试覆盖窗口、终态恢复、目标标签与自定义指标、毫秒单位、engine/role 聚合、真实零值、空值断点、异常采样点和单次查询步长。`node scripts/replay-trend-check.cjs` 使用模拟 HTTP 检查首 Token 单图、等待与空态、tooltip、错误保留、终态固定、刷新恢复、部署切换及迟到响应、中英文和 320px 布局；可用 `CHECK_BASE_URL` 指定预览地址。尚未使用真实后端指标验证。

此功能无需修改 Benchmark。当前 Benchmark 主要返回 `model_name`，不能自动隔离同模型的多个部署或业务流量；新增卡片与右侧曲线均可能包含其他流量。若需要更精确的部署定位，Benchmark 应在现有 `target.metrics_labels` 返回真实部署标签，且这些标签必须同时存在于负载和五项延迟指标上。若要求严格只统计本次回放，需专用部署或后端提供任务级指标；只添加一个指标中不存在的 `replay_id` 标签无法实现隔离。真实五项指标、采集间隔、代理缓存与 PromQL 支持仍需部署联调确认。

### Token 吞吐率趋势（2026-10-16）

首 Token 曲线下方独立绘制输入、输出、总 Token 三条折线，单位 token/s；图例可以开关。只增加两条 LiteLLM counter 区间查询，不新增 req/s 或即时卡片：

```promql
sum by (requested_model) (rate(litellm_input_tokens_metric_total{requested_model="明确的别名",job="litellm"}[1m]))
sum by (requested_model) (rate(litellm_output_tokens_metric_total{requested_model="明确的别名",job="litellm"}[1m]))
```

部署前在 `.env.local` 配置并重新构建（Docker Compose 同样传入该构建参数）：

```dotenv
VITE_REPLAY_THROUGHPUT_CONFIG='{"targets":{"回放的target_model":{"requestedModel":"实际requested_model","labels":{"job":"litellm"}}},"scrapeSeconds":15,"windowSeconds":60,"tailSeconds":60,"timeoutSeconds":300}'
```

`targets` 必须根据新看板实际链路填写；默认 `{}` 显示配置提示，不猜测 vLLM `model_name` 与 LiteLLM 别名的对应关系。各目标的 `labels` 只填写 LiteLLM 实际拥有的标签，不复用回放的 vLLM `metrics_labels`。`inputMetric` / `outputMetric` 可覆盖指标名。回放若绕过 LiteLLM，这两项指标无法观测它，也不会自动回退到 vLLM。按模型/部署统计可能包含其他业务流量。

窗口 `max(windowSeconds,4×scrapeSeconds)`，默认 60 秒；起点 `ceil(started_at+窗口)`，终态终点 `ceil(finished_at+tailSeconds)`。`tailSeconds` 默认 60，必须按实际异步记账延迟调整；终点后再留 30 秒缓存余量，取得一轮在余量结束后发起、覆盖完整尾部的成功查询后停止。短任务不足完整窗口时显示明确空态；固定时段可在刷新后恢复。窗口速率衡量 LiteLLM 记账，不等于逐 Token 解码速度。足够样本下空闲 counter 的 rate 通常是 0，零值正常绘制；缺失、NaN/Inf 则断线。

每轮输入与输出并发，成功项到达即可绘图；上一轮两项完成或超时后开始下一轮，慢查询不阻塞首 Token 或回放进度。总吞吐仅合并同一轮、同一时间戳的有效值；单项失败保留其最后成功数据与时间，总和保留上一轮成功数据并标记等待，绝不混加新旧分量。成功空响应清除该项旧曲线。步长 `max(scrapeSeconds,ceil(区间秒数/300))`，每序列最多约 301 点；页面隐藏时暂停发起查询，恢复可见时补查。

吞吐查询前端超时默认/上限 300 秒，可降低 `timeoutSeconds`；Vite 与本仓库 nginx 指标代理设为 310 秒。已有后端到 Prometheus 的超时（例如 30 秒）仍需部署端协调，前端延长超时不会改变上游限制。指标请求层单独去重在途请求、成功响应缓存 30 秒；吞吐每轮要求两项都在本轮开始后发起，固定终点的失败重试也不复用上轮分量。TTFT 结束补采绕过余量结束前发起的缓存。指标凭据通过连接设置独立输入，仅留页面内存，切换身份清空缓存及已展示的指标。不要把密钥写入 `VITE_` 配置。

`npm test` 覆盖解析、筛选、同轮总和、缓存、鉴权、超时和休眠后的固定时段判断。`scripts/replay-throughput-check.cjs` 验证慢响应、部分失败、清空、鉴权、图例、终态恢复和手机布局；运行前以 `{"targets":{"token-alias":{"requestedModel":"lite-target","labels":{"job":"litellm"}}},"tailSeconds":60}` 配置重新构建。默认空配置构建则以 `CHECK_THROUGHPUT_CONFIGURED=0` 验证配置提示及不发吞吐查询。`scripts/replay-trend-sleep-check.cjs` 验证首 Token 查询期间休眠后不会提前固定。脚本可通过 `CHECK_BASE_URL` 指定预览地址，均使用模拟 HTTP，不发送真实回放流量。

### 回放缓存观测（2026-10-15）

“回放实时延迟”下方新增“回放缓存观测”：三张卡片（KV Cache 使用率、前缀缓存命中率、命中 token/s），一张全宽 KV 趋势图和两张并排的命中趋势图，手机端纵向排列。原有负载和两组延迟观测保持各自规则。区域显示目标模型、部署筛选标签、任务 ID/状态、完整来源历史和成功观测时间。趋势默认使用相对时间，横轴从实际 `started_at` 的 0 起算；取消“相对时间”可查看绝对时间，tooltip 始终保留上海时间。首个真实采样点可以晚于 0，不补造起点数据。

统计口径：

- KV 保留返回序列的全部真实身份标签（例如 instance、pod、engine、role），每条序列单独绘制，纵轴固定 0–100%。卡片由趋势区间结果推导并标明实例：回放中取各实例曲线最后有效点的最大值（“当前实例最大值”，与曲线右端一致，闸门失败时回退到前一个有效点并显示真实样本时间）；任务结束后取回放期间的实例峰值（“回放期间实例峰值”，即曲线最高点）。不相加，也不将未加权平均说成部署总使用率。没有实例标签的单条序列仍可显示，具体身份需采集端提供。
- 前缀缓存命中率为 `100 * sum(rate(hits[窗口])) / sum(rate(queries[窗口]))`，按部署汇总计数率，不平均实例命中率。分母为 0 时显示空值；分母大于 0 且命中为 0 才显示真实 0%。hits 与 queries 必须来自同一计数体系、相同单位和相同工作节点范围。
- 命中 token/s 为 `sum(rate(hits[窗口]))`，**只有确认 hits 计数单位是 token 后才启用**。不同 vLLM 版本可能按缓存块或请求计数，不能将 blocks/s 或 requests/s 标为 token/s，也不按固定 block size 擅自换算。配置 blocks/requests 时可看对应单位的命中率，token/s 保持不可用。

在 `.env.local` 配置（修改后重新执行 `npm run dev`）：

```dotenv
# 默认指标名，KV 按 0~1 缩放；当前部署已确认 hits/queries 都按 token 计数。
VITE_REPLAY_CACHE_CONFIG='{"counterUnit":"tokens"}'
# 其他部署的计数单位未确认时，可显式禁用命中两项：
# VITE_REPLAY_CACHE_CONFIG='{"counterUnit":"unknown"}'
```

完整可选配置示例（以下单位和标签须按真实部署核对，不能视为已确认）：

```dotenv
VITE_REPLAY_CACHE_CONFIG='{"kvMetric":"vllm:kv_cache_usage_perc","kvUnit":"ratio","hitsMetric":"vllm:prefix_cache_hits_total","queriesMetric":"vllm:prefix_cache_queries_total","counterUnit":"tokens","windowSeconds":60,"labels":{"role":"decode"}}'
```

`kvUnit` 支持 `ratio`（0–1，显示时乘 100）或 `percent`（0–100）；名称带 `_perc` 不能证明是 0–100。较旧版本可能用 `vllm:gpu_cache_usage_perc`，须显式改 `kvMetric`，前端不自动混用新旧指标。当前部署的 `counterUnit` 已确认为 `tokens`，默认启用命中率和命中 token/s；也支持显式 `unknown`（不查询命中两项）、`blocks`、`requests`。窗口取配置与真实采集间隔 4 倍的较大值，采集间隔共用 `VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS`。`labels` 仅供缓存指标附加精确筛选，例如排除重复计数的 proxy；不能覆盖任务目标的 model_name 或部署标签，否则显示冲突错误。配置格式见 `.env.example`。

KV 从实际打流开始观测，PromQL 用 `timestamp` 排除回放前 gauge 和超过两次采集间隔的陈旧样本。收到带小数的 `started_at` 时，若尚未到首个可查询整秒，下一整秒即发起查询，不额外等待一轮 30 秒刷新；等待期间相对横轴也从 0 显示。命中两项等待一个完整窗口，趋势第一点为 `ceil(started_at + 窗口)`，每个点都不会读取回放前计数。短任务的结束补采范围不足完整窗口时，命中指标保持空值并明确提示，不混入回放前流量。KV 不受此窗口等待限制。

每轮最多新增 5 条 query_range；显式配置未知单位时仅查询 KV 的一条。命中率/token 卡片用 `start=end=观测Unix秒` 的单点区间查询，趋势用完整区间，终态卡片仍按原任务的固定时刻求值；KV 卡片不再单独查询，由趋势区间结果推导（回放中取最后有效点、终态取全程峰值），与曲线严格一致。所有查询使用相同的无 `@` 表达式，避免旧即时查询代理返回 `HTTP 400 · Invalid query syntax`。区间请求透传 query/start/end/step，步长不小于采集间隔，趋势约最多 301 点/序列。长任务会降采样，窄峰可能漏采（终态峰值同样受网格量化影响）；Prometheus 保留期、超时或最大区间限制仍可能影响恢复范围。空缺点绘为断点，空响应/NaN/Inf 显示空值；超范围百分比显示单位/计数器错误，不强行裁成 100%。

后端模式新增“缓存计数单位”选择器；核对真实指标定义后，可以为当前任务选择 token、缓存块或请求，无需重新构建。选择仅用于当前页面的任务观测，新任务或刷新页面后回到构建配置；长期默认值仍通过 `VITE_REPLAY_CACHE_CONFIG.counterUnit` 配置。未知单位保持命中两项禁用；blocks/requests 可展示命中率，仍不展示 token/s。

页面刷新先恢复原任务，再查询原 `started_at` 起的完整趋势，不重新创建任务。左侧模型/时间选择不改变缓存观测目标。draining、cancelling 仍观测；终态固定在 `ceil(finished_at + 2 × 采集间隔)`，留 30 秒缓存余量并取得一轮无查询错误响应后停止，成功空结果也会停止，不能据此认定样本完整。结束后的命中卡片是固定窗口的近期值，不是任务累计值；KV 卡片是回放全程的实例峰值。缺少 finished_at 时继续轮询。单项卡片/趋势失败独立保留本任务最近成功数据及时间；新任务/目标变化清空旧数据，顶部“刷新指标”可重新查询。

**后端与部署要求（本次不修改 Benchmark）：**

1. 缓存观测使用已有 `GET /api/prometheus/query_range`，透传完整 PromQL、start/end/step，支持 `start=end` 的单点求值，缓存键包含完整参数。返回标准 Prometheus matrix JSON；支持 `timestamp`、`time`、`rate` 和向量匹配。缓存查询不依赖 `@`；其他回放延迟查询的 `@` 要求见上节。无需新增缓存专用接口，指标查询不携带 Benchmark 凭据。
2. Prometheus 采集实际 vLLM 的 KV gauge 和同单位 hits/queries counter，保留所需历史。确认命中率分母定义、计数单位、采集间隔、指标版本、前缀缓存是否启用；缺少指标需在 vLLM/exporter 侧补充，单改 Benchmark 无法生成 KV 数据。`rate` 处理计数器重置；空响应不等于“不支持缓存”。
3. Benchmark 当前主要返回 `target.metrics_labels.model_name`。同模型多部署时，需在现有公共任务响应（`app/benchmark/api.py` 组装目标标签的位置）补充真实 deployment/namespace/job 等标签，并在创建/状态/活动响应保持一致；这些标签须存在于全部相关指标。本项目只记录要求，未修改 Benchmark 文件。
4. 在采集端或 Prometheus 去除 HA 副本、重复 scrape target、proxy/worker 重复计数，或用缓存 labels 筛选唯一采集路径；前端不猜测去重。命中两项对筛选后的序列求和。严格只统计本次回放需专用部署或任务级指标，当前数据可能包含其他业务流量，不添加不存在的 replay_id 标签。

验证使用模拟 HTTP，未向真实部署发流；实际指标名和标签仍需与部署一致。`node scripts/replay-cache-check.cjs` 默认验证 token 计数下的全部三项、刷新恢复、取消状态显示、终态固定历史查询，以及页面内 token/blocks/unknown 单位切换。显式以 unknown 单位构建后，以 `CHECK_CACHE_TOKENS=0` 运行同脚本可验证单位未确认时的空态。

本次 `npm test` 51 项通过，构建/浏览器检查均通过；原有延迟及取消流程浏览器回归通过。另验证了自定义指标前缀、30 秒去重、blocks/requests 单位禁用 token/s、单项错误隔离、空结果清除、相对时间 tooltip、中英文及 320px 布局。新区域与回放延迟使用各自的 React key，避免切换任务时重复挂载；图表不随约 2 秒一次的进度轮询重绘。

再次审查修复：顶部“刷新指标”同时重新查询右侧回放负载曲线，已停止轮询的终态任务也可刷新，仍使用原任务时间；同一任务的模型或部署标签更新时，负载、回放延迟与缓存观测清空旧数据，未完成的旧查询不会覆盖新目标。缓存趋势中的孤立样本显示采样点，避免短任务或停采间隙导致有数据却看不到曲线；缓存卡片首次查询失败时显示“查询失败 · 查看详情”。新增 `node scripts/replay-observation-review-check.cjs`，用模拟 HTTP 验证部署更新、旧响应隔离、首次失败空态、单点曲线、终态手动刷新和页面刷新后的原任务时间恢复。手动刷新仍遵守已有 30 秒指标缓存，实际更新还受后端缓存与采集间隔影响。

KV 卡片改为从趋势结果推导（2026-10-16）：此前卡片单独发 `start=end` 的单点查询，采集缺口触发新鲜度闸门时会清空卡片（曲线同一时刻仍在正常显示），且终态冻结在 `finished_at + 2 × 采集间隔` 的排空后快照，回放结束后常显示 0%。现在卡片直接取趋势区间查询结果：回放中显示各实例曲线最后有效点的最大值（“当前实例最大值”，观测时间为真实样本时间，闸门失败只回退到前一个有效点），任务结束后显示回放全程实例峰值（“回放期间实例峰值”，与曲线最高点一致）；每轮 query_range 由 6 条减为 5 条。命中率/token 卡片、轮询节奏与空值语义不变。`npm test` 56 项通过，全部回放浏览器检查通过。

### 模型列表可加载，但指标提示 404

`BACKEND_URL` 决定请求发往哪台看板服务器，接口路径决定由该服务器哪个路由处理。早期版本模型列表来自 LiteLLM，能加载列表只证明其透传路由可达。当前列表直接查询 Prometheus，但仍应检查每个失败指标请求的实际路径。默认代理不移除 `/api`，通常应将 BACKEND_URL 填为 `http://<BACKEND_IP>:<BACKEND_PORT>`，不要再追加 `/api`。若后端本身安装在子路径，应按实际部署调整代理，不能直接套用此默认配置。

已确认真实后端使用 `prometheus`。早期接口说明中的 `promethues` 拼写有误，会导致 `API route not found`。若自己的 .env.local 仍有旧值，必须修改，否则它会覆盖更新后的代码默认值：

```dotenv
VITE_PROMETHEUS_API_PREFIX=/api/prometheus
```

停止旧服务，再执行 `npm run dev`，刷新页面。这个脚本会重新构建；单独重启 `npm run preview` 不会更新产物中的 VITE_ 变量。生产环境修改这些变量后也必须重新构建并部署，且静态服务器的 `/api` 代理仍须配置。连接设置会显示当前构建使用的路由与当前模型的指标标签。

可直接在浏览器打开看板后端的 `http://<BACKEND_IP>:<BACKEND_PORT>/api/prometheus/query?query=up`。指标查询默认不带认证；若部署启用鉴权，在“连接设置 → 指标认证（可选）”独立填写 x-api-key 或完整 Authorization 值。Benchmark 凭据不会自动附带到指标请求。若正确拼写的路径直接访问仍出现 `API route not found`，请核对看板后端版本与反向代理；修改模型名或 PromQL 不会修复路由 404。若直接访问成功、前端失败，则在 Network 中比较路径，并检查是否仍运行旧构建、是否指向另一服务。

旧看板提供的 `vite.config.js` 将 `/api` 原样代理到 `http://localhost:3000`，没有 rewrite；代理本身不定义或修正 Prometheus 路由。5173 是旧前端地址，并非 API 后端端口，新项目可直接使用同样的 3000 目标。

同机联调可配置：

```dotenv
BACKEND_URL=http://127.0.0.1:3000
VITE_PROMETHEUS_API_PREFIX=/api/prometheus
BACKEND_PROXY_DEBUG=true
```

修改后停止新服务并重新运行 `npm run dev`。终端会显示当前 mode、实际加载的代理目标以及每个请求的上游 HTTP 状态，日志不输出查询参数或认证头；联调结束可关闭 debug。如果新旧前端表现不同，比较 `localhost:3000`、`127.0.0.1:3000`、旧 5173 和新 5174 的同一路径 `?query=up`。localhost 可能解析到 IPv6，127.0.0.1 则固定为 IPv4；若它们实际连接到不同服务，响应才会不同。debug 显示的目标不符合 .env.local 时，还应检查运行目录、进程环境变量，以及 `.env.production` / `.env.production.local` 中的覆盖值：本项目 npm run dev 使用 build + preview，默认为 production mode。

当前 Vite 的 preview 默认继承 server.proxy，本项目另将 preview.proxy 显式设为同一对象便于核对；显式配置本身不能证明已修复生产环境的 404。如果正确目标上的简单查询成功，而某条业务 PromQL 返回 404，应复制旧前端成功查询的完整 URL 参数，在新前端执行同一查询，并查看后端路由日志，而不是继续更换接口前缀。

### Prometheus 模型列表与回放名称

模型下拉框直接从 `count by (model_name) (vllm:num_requests_running)` 的 vector 标签生成。Prometheus 必须已配置采集各 vLLM 的 `/metrics`；前端通过看板后端查询，不直接访问 vLLM。不需要新增后端接口。值为 0 的空闲模型仍保留，同名 engine/role 合并为一个选项。

新增或重命名的模型在 Prometheus 采集后，点击“刷新列表”即可获取；前后端均有 30 秒缓存，因此可能需要等待 TTL 到期。该列表反映当前已采集且仍有效的序列，停止采集或过期的旧模型不会因为历史范围较长就自动出现在列表中。

历史延迟卡和历史负载曲线使用下拉框所选名称匹配 `model_name`。回放请求默认将该名称作为 `source_model`；`target_model` 独立从 Benchmark 目标列表选择。如果档案中使用别名，需要显式配置：

```dotenv
VITE_MODEL_METRICS_MAP='{"qwen-service":"Qwen/Qwen3-32B-v2"}'
```

此时下拉框显示 `Qwen/Qwen3-32B-v2`，历史指标也筛选该名称，回放请求提交 `source_model: "qwen-service"`。目标仍由按钮独立选择，目标别名到灰度指标名使用 `VITE_REPLAY_MODEL_METRICS_MAP` 单独配置；未配置时兼容旧的共享映射。多个别名对应同一来源指标名时，仍需唯一确定历史档案别名。连接设置显示历史 model_name、source_model 和 target_model。

路由成功但指标为空时，再核对 vLLM 是否已被采集、时间范围、实际指标名和模型标签。五张延迟卡片的 rate 窗口跟随历史查询范围；若 scrape interval 大于所选窗口或窗口内没有请求，Prometheus 可能返回空结果或 `NaN`。这些问题与 `API route not found` 是不同层次。

## 待联调的约定

- 模型发现：`src/data.ts` 的 `fetchModels` / `parseModelVector`，从即时查询的 `model_name` 标签生成下拉项；`adaptModels` 保留为旧 LiteLLM 适配函数，首页不再调用它。回放后端需能识别该模型名，或配置一对一的 `VITE_MODEL_METRICS_MAP`。
- 指标清单和 PromQL 在 `src/data.ts` 的 `loadQueries`、`metricQueries`。TTFT/E2E/ITL/QT 使用 `rate(_sum[窗口]) / rate(_count[窗口])`，TPOT 使用上述解码耗时与生成 token 的特殊比值，共五条独立即时 query。模型标签来自当前下拉框，窗口来自历史查询范围；指标名可用 `VITE_PROMETHEUS_METRIC_NAMES` 覆盖。卡片数值是 Prometheus 即时查询在该回溯窗口内的 rate 结果，不是 query_range 曲线的前端平均。
- 负载曲线：`sum by (model_name) (vllm:num_requests_running{model_name="所选模型"})` 和对应的 `num_requests_waiting`，在 Prometheus 汇总全部 engine 和 role。历史与回放各展示一条处理曲线、一条等待曲线；回放返回的部署标签仍用于筛选目标。前端直接绘制总值，不再平均。DeepSeek 的 proxy/prefill/decode 总和表示各阶段负载总和；若 proxy 和 worker 同时记录同一请求，该值不等于去重后的用户请求数。该口径不依赖 `VITE_MIXED_LATENCY_ROLE_MODELS`，普通模型同样汇总全部 engine。
- 回放创建默认 `POST /api/replays`，请求体 `{ source_model, target_model, start_time, end_time, speed }`，Unix 秒，左闭右开。`speed` 为正数或精确字符串 `"burst"`；界面选择 `∞` 时发送 `"burst"`，数字选项仍发送 number。返回 `{ replay_id, source_model, target_model, status, started_at?, request_count?, target?: { metrics_labels } }`。
- 状态接口默认 `GET /api/replays/{id}`，返回 `{ status, started_at?, finished_at?, request_count?, sent_count?, completed_count?, failed_count?, skipped_count?, progress?, error?, target?: { metrics_labels } }`。状态支持 queued/preparing/running/draining/cancelling/succeeded/failed/cancelled；取消按钮依据 `cancellable` 启用，接受取消后继续轮询直到终态。`finished_at` 为全部请求处理完成时间。创建、状态、活动、取消路径分别通过 VITE_REPLAY_CREATE_PATH / VITE_REPLAY_STATUS_PATH / VITE_REPLAY_ACTIVE_PATH / VITE_REPLAY_CANCEL_PATH 配置。
- 接口尚未与真实部署的 LiteLLM、SpendLogs 和 Prometheus 完成联调；已使用当前 Benchmark HTTP 接口及模拟数据做隔离验证。创建回放响应缺少 replay_id 会明确报错。未知实际开始时间时，前端不会用点击时间替代。

切换模型会清空历史选区，但保留已创建任务的模型。两个图窗使用相同纵轴上限；回放窗口可切换相对时间，历史窗口仍保留绝对时间。相对横轴从实际回放开始的 0 起算，使用数值轴；不足一分钟显示秒，较长区间显示分:秒或时:分:秒，tooltip 同时保留实际时刻。该开关只影响显示，不改变查询或回放参数。每次只创建一个活动任务。

## 当前 Benchmark 对接检查与缺口

2026-10-15 按拉取后的 `D:\ai_workspace\Benchmark` 当前提交 `ef22cd2`（包含 `60e2cd0` 的 burst 实现）复核：创建、状态、活动任务、幂等和基础计数字段兼容，当前 Benchmark 已原生支持数字倍速和 `speed: "burst"`，但本地配置尚未接入独立 Benchmark，兼容补丁中的其余能力也未全部合入。以下为此次检查时的状态，调整配置或移植缺失能力后应重新验证。

| 缺口 | 当前行为及影响 | 补齐方式 |
| --- | --- | --- |
| 独立回放地址未配置 | 前端 `.env.local` 仅设置 `BACKEND_URL=http://127.0.0.1:3000`，未设置 `REPLAY_BACKEND_URL`，因此回放请求也发往 3000。 | 将 `REPLAY_BACKEND_URL` 设置为 Vite/生产代理能够访问的 Benchmark 地址；指标继续使用原 `BACKEND_URL`。 |
| 任务响应缺少 `revision` | Benchmark 已原样返回创建时的数字倍速或 `"burst"`，但公共响应没有递增版本号；前端不能按版本号拒绝迟到的旧响应。 | 将兼容补丁中的任务版本能力移植到当前 Benchmark。 |
| `view=status` 未提供轻量响应 | 活动/状态接口忽略该参数，隔离验证中两者均返回注入的全部 1,000 条 `results`；约每 2 秒的轮询会反复下载结果文本，任务越大响应越重。 | 移植兼容补丁中的轻量响应能力，使 `?view=status` 省略 `results`，保留原完整查询接口。 |
| 后端实际指标标签映射未实现 | 公共响应直接用目标模型名作为 `model_name`；隔离验证配置 `BENCHMARK_MODEL_METRICS_MAP={"alias":"real-model"}` 后仍返回 alias。LiteLLM 别名与指标名不同时，未配置映射的曲线查询可能为空。 | 当前可配置前端 `VITE_REPLAY_MODEL_METRICS_MAP`，正式历史单独用 `VITE_MODEL_METRICS_MAP`；无需为本次分源修改后端。 |
| 取消与调度提交存在竞态 | `app/benchmark/core.py` 在取消检查和线程池提交之间未使用同一把锁；在该间隙插入真实 HTTP 取消后，接口已返回 202/cancelling，调度线程仍提交了一个请求。状态更新也缺少取消中/终态保护。 | 移植兼容补丁中的原子提交与状态保护，使取消受理与提交共用锁；已提交的请求仍等待处理结束。 |
| burst 未及时进入 draining | `run_replay` 的突发循环等待所有在途请求结束后才退出；隔离验证中 total=2、sent=2、completed=0 时仍返回 running，`dispatch_finished` 尚未置位。前端会继续显示“回放中”，通常观察不到独立的等待响应阶段。 | 最后一个请求提交后即设置 draining/dispatch_finished，再等待在途响应；终态仍以全部处理结束为准。 |

当前 Benchmark 已精确识别 `speed: "burst"`，内部使用突发调度并在公共任务响应中继续返回 `"burst"`。突发模式取消历史请求间隔，按 `BENCHMARK_MAX_WORKERS` 并发上限持续提交请求；它不会绕过线程池或上游容量限制。

两个服务与 Vite 同机时，前端 `.env.local` 可按下面配置；部署到不同机器或容器时，地址应改为代理实际可访问的地址。修改后重新运行 `npm run dev`：

```dotenv
BACKEND_URL=http://127.0.0.1:3000
REPLAY_BACKEND_URL=http://127.0.0.1:8088
VITE_REPLAY_AUTH_MODE=manual
```

Benchmark 不提供 `/api/prometheus/query` 和 `/api/prometheus/query_range`，这两个接口继续由已有看板后端实现。2026-10-26 起前端创建请求使用独立的 `source_model` 与 `target_model`：前者匹配 SpendLogs 来源，后者匹配 LiteLLM 可用模型，无需两者同名。

隔离验证覆盖创建、幂等重试、进度条更新、刷新重建曲线、无本地记录时恢复活动任务、普通取消、五种数字倍速及 `∞`。当前 Benchmark 的完整兼容性脚本在指标映射断言处失败；逐项隔离验证另确认上述轻量响应、取消竞态、版本号和 burst 状态缺口。Vite 双后端分流与认证透传检查通过。验证使用临时任务库、本地 HTTP 和模拟工作线程，不发送真实推理流量，也未验证真实部署的数据链路。

`integration/benchmark-replay.patch` 基于较早的 Benchmark 版本，不能直接应用到当前 `main`。需要从补丁中选择尚未合入的能力并移植到当前代码，完成代码审查和隔离验证后再重启服务或重建镜像；不要直接执行 `git apply`。

后端完整契约可从本项目前端目录执行 `python scripts/benchmark-replay-check.py D:/ai_workspace/Benchmark` 验证。该脚本使用临时状态库和模拟执行，不发送真实推理请求；只有检查通过的后端版本才能视为满足完整契约。

## 限制

回放接口已按独立 Benchmark 的响应字段接入，真实部署仍需配置地址、认证并联调。前端状态和活动查询使用 `?view=status`，应用兼容补丁后的 Benchmark 不携带逐请求 `results`；原完整结果查询保持兼容。共享实例曲线包含其他流量，不能仅凭 model_name 区分回放来源。生产环境需要配置可区分部署的指标标签。花费卡、投机解码和模型实例树未在首版接入。

## 已完成验证

早期验证：TypeScript 与生产构建通过；37 项解析、接口配置、缓存、模型映射、时间轴、时区、回放响应适配及曲线失败恢复测试通过，包含 DeepSeek 延迟混合 role 单行、NaN 分片跳过、engine 均值，以及历史/回放负载求和与目标部署筛选。浏览器验证覆盖拖拽选区、模型切换、固定回放模型、手机宽度、相对时间秒刻度和 tooltip、切回绝对时间、运行时错误，以及模拟 HTTP 响应的后端路径和 NaN 显示；2026-10-26 起创建请求更新为来源、目标、区间和倍速五字段。scripts/backend-check.cjs 验证历史与回放窗口各只有一条处理曲线、一条等待曲线，tooltip 保留求和后的总值。scripts/latency-check.cjs 另验证五条独立延迟 query、当前模型和历史范围过滤、旧响应隔离、慢历史查询隔离、部分失败详情与空样本。scripts/replay-progress-check.cjs 验证 Bearer 认证、创建计数、准备/零总数、慢曲线不阻塞 2 秒进度刷新、失败时保留数据、中英文、取消中、失败达到 100%、终态停止与 320px 布局。scripts/proxy-check.cjs 使用本地模拟服务验证双后端分流、自定义路径与认证头透传。上述浏览器验证使用模拟响应，尚未连接真实后端。



## 倍速、取消与刷新恢复

创建前选择 0.5× / 1× / 2× / 5× / 10× / `∞`，默认 1×。数字倍速缩放请求发送间隔；选择 `∞` 时前端仍只发送原有四个字段，其中 `speed` 为字符串 `"burst"`，后端忽略历史请求间隔并尽快提交所选区间的全部请求。线程池并发仍受后端上限约束，因此 `∞` 表示取消历史节奏。创建后的任务参数固定，不能运行中改速。状态原样返回 `speed`；旧后端未知倍速显示“倍速未知”，不默认显示原速。

前端类型为 `ReplaySpeed = number | 'burst'`，这只扩展允许的值，原有数字请求格式不变。选择框、确认弹窗和任务摘要均将 `burst` 显示为 `∞`；刷新恢复和未确认请求的幂等重试保留原值。

真实打流需要后端同步支持。当前 `D:\ai_workspace\Benchmark` 的 `main` 已保留数字倍速原有解析行为，精确识别 `"burst"`，并在幂等指纹和公共任务响应中保留突发模式。调度器不再等待历史请求间隔，而是在并发槽位空闲时继续提交；全部请求处理结束后才进入终态。部署仍需包含这版实现并在更新后重启服务或重建镜像。

进入后端模式并有认证后，先请求 `GET /api/replays/active?view=status`；有活动任务则恢复，没有则用本地保存的最后 ID 请求 `GET /api/replays/{replay_id}?view=status`，覆盖刷新期间刚完成的情况。恢复失败阻止创建，可手动重试。创建遇到 `409 + active_task` 时展示该任务。恢复已知任务只 GET，不重新打流，也不需要重新填写倍速或幂等键。

页面刷新不会取消后端打流；曲线可能短暂为空，随后从实际开始时间重新查询并恢复已有曲线。正常情况下，任务状态和进度约每 2 秒更新，回放曲线每 30 秒更新；页面隐藏时暂停查询，重新可见时立即补查。

恢复任务和曲线所需的响应字段如下，均由后端返回，前端自动读取：

| 字段 | 用途 |
| --- | --- |
| `replay_id`、`status` | 确认任务身份及状态，继续查询该任务进度。 |
| `model_id` 或 `target_model`、`source_model` | 恢复目标及源模型；未返回 `source_model` 时前端按同一模型处理。 |
| `start_time`、`end_time` | 原历史选区的 Unix 秒时间戳，用于恢复左侧历史窗口。 |
| `speed` | 创建时固定的正数或 `"burst"`；前端分别恢复为数字倍速或 `∞`。 |
| `started_at` | 实际打流开始时间，Unix 秒；回放曲线从此处开始，不使用原历史选区的起点。尚未实际开始时可以省略。 |
| `target.metrics_labels` | 实际 Prometheus 模型和部署标签，优先用于筛选回放曲线；未提供时使用前端模型映射或模型名。 |
| `progress.ready`、`progress.total`、`progress.completed` | 展示准备状态、“已完成 / 总请求”和进度条；兼容旧字段 `request_count`、`completed_count`。 |
| `finished_at` | 任务结束时间，Unix 秒；用于确定尾部曲线范围和停止曲线轮询。 |

两条回放曲线继续通过已有看板后端的 `GET /api/prometheus/query_range` 获取。每次分别查询处理和等待曲线，参数由前端自动生成：

| 参数 | 取值 |
| --- | --- |
| `query` | 下方 PromQL；任务提供其他部署标签时，一并加入筛选条件。 |
| `start` | 任务实际打流开始时间 `started_at`，Unix 秒。 |
| `end` | 运行中为 `max(started_at + 30, 当前 Unix 秒)`；终态为 `finished_at + 2 × 灰度采集间隔`，默认间隔 15 秒时即 `finished_at + 30`。 |
| `step` | `max(5, ceil((end-start)/60))`，单位秒，约 60 个采样点。 |

```promql
sum by (model_name) (vllm:num_requests_running{model_name="实际指标模型名"})
sum by (model_name) (vllm:num_requests_waiting{model_name="实际指标模型名"})
```

这里恢复的是从实际开始时间到当前查询终点的整段指标，而不是只查询刷新后的新点。任务结束后，在 `finished_at + 2 × 灰度采集间隔 + 30 秒缓存余量` 之后发起的一轮查询成功时停止曲线轮询；最终轮次绕过此前的前端缓存，休眠或慢响应不能让过早发起的查询满足停止条件。曲线能否完整恢复取决于任务接口返回的时间和标签是否正确，以及 Prometheus 是否仍保留相应时段的数据；共享实例的指标也可能包含其他流量。完整任务响应契约见 [回放接口文档](docs/replay-api.md)。

取消按钮仅在 `cancellable=true` 启用。`202` 进入 cancelling 后继续更新；`409 + task` 更新实际终态。旧轮询响应不能撤销取消或降低计数。已经提交给工作线程的请求仍可完成，进度不强制填满。

### 刷新后的认证值如何填写

认证值来自 **Benchmark 服务实际运行时配置的 `BENCHMARK_API_KEY`**，通常在 Benchmark 项目根目录的 `.env` 或部署环境变量中设置。它是保护创建、状态、活动任务及取消接口的独立密钥，不使用 LiteLLM 的 `LITELLM_MASTER_KEY`。只在前端填写任意新值不会生效，必须与后端的实际密钥一致；模板中的 `replace-with-a-long-random-secret` 应在部署时替换为实际密钥。

默认 `VITE_REPLAY_AUTH_MODE=manual`，页面刷新后按以下步骤填写：

1. 点击右上角“连接设置”或恢复提示中的“填写认证”。
2. “认证头”选择 `Authorization`；当前 Benchmark 不接受 `x-api-key` 或 `x-litellm-key`。
3. “认证值”填写 `Bearer`、一个空格、实际 `BENCHMARK_API_KEY`，不要加尖括号或引号，也不要填写 `BENCHMARK_API_KEY=`。页面不会自动添加 `Bearer` 前缀。
4. 点击“应用设置”，前端重新查询活动任务并恢复状态、进度和曲线，不重新创建任务。

例如，**仅说明格式的假密钥**为 `benchmark-example-key` 时，页面填写：

```text
Bearer benchmark-example-key
```

手动模式只把认证值保存在页面内存，不写入 localStorage/sessionStorage，因此每次刷新需要再次填写同一个密钥；不需要生成新的密钥。空值或错误密钥不能完成任务恢复，后端缺少或错误认证返回 HTTP 401。刷新本身不取消后端打流。

### 认证是否必需，以及如何免手动填写

**Benchmark 回放任务接口的认证必需；是否需要在页面手动填写取决于认证模式。** Prometheus 指标接口本身不需要 Benchmark 密钥，已有本地任务快照可用于重新查询曲线，但不能替代对最新任务状态的确认。

| 使用方式 | 是否需要页面填写认证值 |
| --- | --- |
|  | 不需要，任务和数据在浏览器中模拟。 |
| 历史指标查询及 Prometheus 曲线查询 | 不需要 Benchmark 密钥，指标查询不携带该认证。 |
| 后端回放，`manual` 模式 | 需要，创建/恢复/进度查询/取消都使用该认证；刷新后重新填写。 |
| 后端回放，`proxy` 模式 | 不需要页面填写，但服务端代理必须注入与 Benchmark 一致的密钥。 |

需要刷新后自动恢复时，在前端未提交的 `.env.local` 中配置，并重新运行 `npm run dev`：

```dotenv
VITE_REPLAY_AUTH_MODE=proxy
REPLAY_BACKEND_URL=http://127.0.0.1:8088
BENCHMARK_API_KEY=实际Benchmark密钥
```

这里的 `BENCHMARK_API_KEY` 为与 Benchmark 一致的原始密钥，不加 `Bearer`；地址示例假设 Benchmark 与 Vite 同机。Vite 服务端仅向回放路由注入 `Authorization: Bearer 实际密钥`，密钥不进入浏览器构建，也不附加到 Prometheus 请求。仅在前端 `.env.local` 设置密钥、却继续使用 `manual` 模式，不会自动认证。Vite 绑定本机回环地址。生产静态站点必须在已有受控、带访问认证的同源反向代理中对回放路由注入该头；构建参数不会自动创建生产代理或用户会话，不能把携带服务密钥的代理公开成无认证接口。

当前 Benchmark 已原生返回数字或 burst 的 `speed`；递增 `revision`、轻量状态、取消与提交的原子互斥、后端 `BENCHMARK_MODEL_METRICS_MAP` 仍需按当前代码移植，旧兼容补丁仅作为参考。具体影响见“当前 Benchmark 对接检查与缺口”。浏览器刷新不停止后端任务；Benchmark 进程重启仍会使活动任务失败，未增加断点续跑。

验证命令：`npm run build`、`npm test`、`node scripts/replay-recovery-check.cjs`、`node scripts/replay-edge-check.cjs`、`node scripts/replay-progress-check.cjs`、`node scripts/proxy-check.cjs`。浏览器检查默认使用本地 4173 预览服务。后端隔离验证：`python scripts/benchmark-replay-check.py D:/ai_workspace/Benchmark`，只使用临时任务库和本地模拟请求，不访问真实模型。
