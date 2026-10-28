# ---------- 构建段：Node 22 LTS，与本地开发环境一致 ----------
FROM node:22-alpine AS build
# 国内服务器构建加速可覆盖：--build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app

# 先复制依赖清单并安装；package*.json 不变时命中层缓存，不重跑 npm ci。
COPY package.json package-lock.json ./
RUN npm ci --registry="$NPM_REGISTRY"

# VITE_ 变量在构建时注入产物（优先级高于 .env 文件）；默认空串时前端代码
# 回落内置默认值（src/App.tsx 的 || 兜底、src/apiConfig.ts 的 trim 守卫）。
# 修改这些值后必须重新构建镜像，运行时环境变量无法改变它们。
ARG VITE_PROMETHEUS_API_PREFIX=
ARG VITE_REPLAY_PROMETHEUS_API_PREFIX=
ARG VITE_REPLAY_THROUGHPUT_PROMETHEUS_API_PREFIX=
ARG VITE_MODEL_INFO_PATH=
ARG VITE_MODEL_METRICS_MAP=
ARG VITE_REPLAY_MODEL_METRICS_MAP=
ARG VITE_MIXED_LATENCY_ROLE_MODELS=
ARG VITE_PROMETHEUS_METRIC_NAMES=
ARG VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS=
ARG VITE_REPLAY_LATENCY_WINDOW_SECONDS=
ARG VITE_REPLAY_THROUGHPUT_CONFIG=
ARG VITE_REPLAY_CACHE_CONFIG=
ARG VITE_REPLAY_CREATE_PATH=
ARG VITE_REPLAY_STATUS_PATH=
ARG VITE_REPLAY_ACTIVE_PATH=
ARG VITE_REPLAY_CANCEL_PATH=
ARG VITE_REPLAY_STORAGE_SCOPE=
# manual：页面输入认证值；proxy：由运行时代理注入 BENCHMARK_API_KEY（见下方注释）。
ARG VITE_REPLAY_AUTH_MODE=
# 占位密钥：vite.config.mjs 在 proxy 模式构建时要求此变量存在（为本地 Vite 代理设计）。
# 默认占位值即可通过校验；产物不含该值（非 VITE_ 前缀不进入客户端代码），
# 真实密钥只在运行时经环境变量注入，勿用 --build-arg 传入真实密钥。
ARG BENCHMARK_API_KEY=build-time-placeholder
ENV VITE_PROMETHEUS_API_PREFIX=$VITE_PROMETHEUS_API_PREFIX \
    VITE_REPLAY_PROMETHEUS_API_PREFIX=$VITE_REPLAY_PROMETHEUS_API_PREFIX \
    VITE_REPLAY_THROUGHPUT_PROMETHEUS_API_PREFIX=$VITE_REPLAY_THROUGHPUT_PROMETHEUS_API_PREFIX \
    VITE_MODEL_INFO_PATH=$VITE_MODEL_INFO_PATH \
    VITE_MODEL_METRICS_MAP=$VITE_MODEL_METRICS_MAP \
    VITE_REPLAY_MODEL_METRICS_MAP=$VITE_REPLAY_MODEL_METRICS_MAP \
    VITE_MIXED_LATENCY_ROLE_MODELS=$VITE_MIXED_LATENCY_ROLE_MODELS \
    VITE_PROMETHEUS_METRIC_NAMES=$VITE_PROMETHEUS_METRIC_NAMES \
    VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS=$VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS \
    VITE_REPLAY_LATENCY_WINDOW_SECONDS=$VITE_REPLAY_LATENCY_WINDOW_SECONDS \
    VITE_REPLAY_THROUGHPUT_CONFIG=$VITE_REPLAY_THROUGHPUT_CONFIG \
    VITE_REPLAY_CACHE_CONFIG=$VITE_REPLAY_CACHE_CONFIG \
    VITE_REPLAY_CREATE_PATH=$VITE_REPLAY_CREATE_PATH \
    VITE_REPLAY_STATUS_PATH=$VITE_REPLAY_STATUS_PATH \
    VITE_REPLAY_ACTIVE_PATH=$VITE_REPLAY_ACTIVE_PATH \
    VITE_REPLAY_CANCEL_PATH=$VITE_REPLAY_CANCEL_PATH \
    VITE_REPLAY_STORAGE_SCOPE=$VITE_REPLAY_STORAGE_SCOPE \
    VITE_REPLAY_AUTH_MODE=$VITE_REPLAY_AUTH_MODE

COPY . .
RUN npm run build

# ---------- 运行段：nginx 托管静态产物并承担同源反向代理 ----------
# 运行时环境变量（改后 docker compose up -d 即生效，无需重建镜像）：
#   BACKEND_URL          必填，看板指标后端，只填协议+IP+端口，不追加 /api
#   REPLAY_BACKEND_URL   可选，独立 Benchmark 回放后端；留空回落 BACKEND_URL
#   REPLAY_PROMETHEUS_URL 可选，灰度 Prometheus 地址；未配置时灰度指标返回 503
#   REPLAY_PROMETHEUS_BEARER_TOKEN 可选，只用于灰度 Prometheus 的上游认证
#   REPLAY_PROMETHEUS_PATH_PREFIX 与构建时 VITE_REPLAY_PROMETHEUS_API_PREFIX 一致
#   REPLAY_PATH_PREFIX   可选，回放路径前缀，默认 /api/replays
#   VITE_REPLAY_AUTH_MODE 可选 manual|proxy；proxy 时须提供 BENCHMARK_API_KEY
#   BENCHMARK_API_KEY    仅 proxy 模式需要；由启动脚本注入回放路由的 Authorization 头
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx/default.conf.template /etc/nginx/dashboard/default.conf.template
# 启动脚本由官方 nginx entrypoint 自动执行，生成 /etc/nginx/conf.d/default.conf；必须保留可执行位。
COPY --chmod=755 docker/nginx/15-generate-default-conf.sh /docker-entrypoint.d/15-generate-default-conf.sh
