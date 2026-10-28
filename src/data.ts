import type { LatencyMetricKey, LoadData, Metric, MetricKey, Metrics, Model, Point, Series, TimeRange } from './types';
import { DEFAULT_API_CONFIG, type ApiConfig, type MetricNameConfig } from './apiConfig';
import type { Language } from './i18n';

/**
 * 数据入口与适配层。
 * 真实指标：vLLM /metrics → Prometheus → 看板后端 /api/prometheus/*
 *          → 本文件解析 vector/matrix → App 状态 → 指标卡 / LoadChart。
 * 模型列表：vLLM /metrics → Prometheus model_name 标签 → fetchModels → 模型下拉框。
 * 后端返回原样 Prometheus JSON；历史 gauge 在 PromQL 聚合，延迟的 engine 均值在解析时合并。
 */
type Labels = Record<string, string>;
// Prometheus 的数值字段是字符串；时间戳为 Unix 秒，不是 JavaScript 毫秒。
interface PromSeries { metric: Labels; value?: [number, string]; values?: [number, string][] }
interface PromResponse { status: string; data?: { resultType: string; result: PromSeries[] }; error?: string }

/** 缺失值与真实 NaN/Inf 分开保存，避免无流量的 0/0 被误显示为 0。 */
export function parsePromValue(raw: string): number | undefined {
  if (raw === 'NaN') return NaN;
  if (raw === '+Inf' || raw === 'Inf') return Infinity;
  if (raw === '-Inf') return -Infinity;
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
// 仅用于展示，不改写解析后的原始值；NaN 的红色样式由组件负责。
export function formatValue(value?: number, decimals = 2, language: Language = 'zh'): string {
  if (value === undefined) return '—';
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return value.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: decimals });
}
/**
 * 区间秒数 → 约 60 个点的查询步长，最小 5s；即时卡片的 rate 窗口单独按用户选择的历史范围生成。
 */
export function queryTiming(seconds: number, now = Math.floor(Date.now() / 1000)) {
  const step = Math.max(5, Math.ceil(seconds / 60));
  return { start: now - seconds, end: now, step, window: `${Math.max(30, step)}s` };
}
// 图表拖拽产生的两个时间边界排序并裁剪到查询窗口，支持向左拖动。
export function normalizeRange(a: number, b: number, bounds: TimeRange): TimeRange {
  const first = Math.round(Math.max(bounds.start, Math.min(bounds.end, a)));
  const second = Math.round(Math.max(bounds.start, Math.min(bounds.end, b)));
  return { start: Math.min(first, second), end: Math.max(first, second) };
}
function promResult(raw: unknown, type: string): PromSeries[] {
  const data = raw as PromResponse;
  if (data?.status !== 'success') throw new Error(data?.error || 'Prometheus 查询失败');
  if (data.data?.resultType !== type || !Array.isArray(data.data.result)) throw new Error('Prometheus 响应类型不匹配');
  return data.data.result;
}
/**
 * query_range 的 matrix → Series[]，传给处理/等待折线。
 * vLLM 按 model_name 分组；接入 LiteLLM 指标时可传 requested_model。
 * 若查询返回 role 则保留为独立曲线；负载查询已汇总所有 role/engine，不在此二次聚合。
 */
export function parseMatrix(raw: unknown, label = 'model_name'): Series[] {
  const groups = new Set<string>();
  return promResult(raw, 'matrix').map(s => {
    const name = s.metric[label];
    if (!name) throw new Error(`指标缺少 ${label} 标签`);
    const role = s.metric.role;
    const id = JSON.stringify([name, role ?? '']);
    if (groups.has(id)) throw new Error('查询返回重复分组，请在 PromQL 中聚合 engine 分片');
    groups.add(id);
    return { id, name: name + (role ? ` · ${role}` : ''), points: (s.values ?? []).map(([timestamp, value]) => ({ timestamp, value: parsePromValue(value) })).sort((a,b)=>a.timestamp-b.timestamp) };
  });
}
// query 的 vector → 单个卡片数值。空结果为 undefined，多条结果说明聚合口径不匹配。
export function parseVector(raw: unknown): number | undefined {
  const result = promResult(raw, 'vector');
  if (result.length > 1) throw new Error('卡片查询应在 PromQL 中聚合为单个结果');
  return result[0]?.value ? parsePromValue(result[0].value[1]) : undefined;
}
/**
 * 未聚合的延迟比值（包括 TPOT 的特殊分母）返回各 engine 的延迟均值。
 * 普通模型按 role 分行；DeepSeek 等配置的模型混合 proxy/prefill/decode 后只展示一行。
 * 空闲分片的 NaN 不参与平均；若所有分片都是 NaN，则保留真实 NaN 信号。
 */
export function parseLatencyVector(raw: unknown, modelName: string, mixedRoleModels: string[] = DEFAULT_API_CONFIG.mixedLatencyRoleModels): Metric {
  const mixedRoles = mixedRoleModels.some(token => modelName.toLocaleLowerCase().includes(token.toLocaleLowerCase()));
  const groups = new Map<string, (number | undefined)[]>();
  for (const series of promResult(raw, 'vector')) {
    if (series.metric.model_name && series.metric.model_name !== modelName) {
      throw new Error('延迟响应包含其他模型，请检查 PromQL 模型筛选');
    }
    const role = mixedRoles ? '' : (series.metric.role || '');
    const values = groups.get(role) ?? [];
    values.push(series.value ? parsePromValue(series.value[1]) : undefined);
    groups.set(role, values);
  }
  const rows = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([role, values]) => {
    const present = values.filter((value): value is number => value !== undefined && !Number.isNaN(value));
    // 只有 NaN/缺失值时保留 NaN；不能把真实的无流量信号改成 0 或空值。
    const value = present.length ? present.reduce((total, next) => total + next, 0) / present.length : values.some(value => Number.isNaN(value)) ? NaN : undefined;
    return { name: modelName + (role ? ` · ${role}` : ''), role: role || undefined, value };
  });
  if (rows.some(row => row.role)) return { rows };
  return { value: rows[0]?.value };
}
// 单引号和尖括号转义；PromQL 标签匹配所需的双引号保留。
export function promString(value: string): string {
  return JSON.stringify(value).replace(/'/g, '\\x27').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
}
export function selector(modelName: string, labels: Labels = {}): string {
  // 回放响应可提供部署标签和实际 model_name；优先使用后端映射的标签定位目标实例。
  const merged = { ...labels, model_name: labels.model_name || modelName };
  return '{' + Object.entries(merged).map(([key, value]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error('非法指标标签');
    return `${key}=${promString(value)}`;
  }).join(',') + '}';
}
// running/waiting 是瞬时 gauge。按所选模型对全部 role/engine 求和，表示集群各阶段负载总和。
// 历史和回放共用此口径；部署等标签只用于筛选目标，不保留为额外曲线。
// proxy 若与 worker 同时记录同一请求，此总和不等于去重后的用户请求数。
export function loadQueries(modelName: string, labels?: Labels) {
  const filter = selector(modelName, labels);
  return {
    running: `sum by (model_name) (vllm:num_requests_running${filter})`,
    waiting: `sum by (model_name) (vllm:num_requests_waiting${filter})`
  };
}
/** PromQL duration：避免 0h0m 这类 Prometheus 不接受的写法。 */
export function promDuration(seconds: number): string {
  if(!Number.isFinite(seconds)||seconds<=0)throw new Error('rate 回溯范围必须是正数秒');
  const value = Math.max(1, Math.round(seconds));
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

const defaultMetricNames: Record<LatencyMetricKey, MetricNameConfig> = {
  ttft: { sum: 'vllm:time_to_first_token_seconds_sum', count: 'vllm:time_to_first_token_seconds_count' },
  e2e: { sum: 'vllm:e2e_request_latency_seconds_sum', count: 'vllm:e2e_request_latency_seconds_count' },
  itl: { sum: 'vllm:inter_token_latency_seconds_sum', count: 'vllm:inter_token_latency_seconds_count' },
  // 用户确认的 TPOT：解码总耗时 ÷（生成 token 总数 - 请求数），扣除每个请求的首 token。
  tpot: { decodeSum: 'vllm:request_decode_time_seconds_sum', generationTokensSum: 'vllm:request_generation_tokens_sum', generationTokensCount: 'vllm:request_generation_tokens_count' },
  qt: { sum: 'vllm:request_queue_time_seconds_sum', count: 'vllm:request_queue_time_seconds_count' }
};

/**
 * 五张首页卡片各发一条即时 query。后端按 TTL 缓存后透传 Prometheus 的原样响应。
 * rate 窗口就是历史查询范围（例如 30m、24h、7d），不是固定 1m。
 */
export interface MetricQueryOptions { labels?: Labels; evaluatedAt?: number; freshAfter?: number }
export function metricQueries(modelName: string, windowSeconds: number, config: ApiConfig = DEFAULT_API_CONFIG, options: MetricQueryOptions = {}) {
  const f = selector(modelName, options.labels);
  const window = promDuration(windowSeconds);
  if (options.evaluatedAt !== undefined && (!Number.isFinite(options.evaluatedAt) || options.evaluatedAt < 0)) throw new Error('无效的延迟观测时间');
  // 将观测时间写入 PromQL，兼容只透传 query 的已有指标后端；原有卡片不带 @。
  const at = options.evaluatedAt === undefined ? '' : ` @ ${Math.floor(options.evaluatedAt)}`;
  return (Object.keys(defaultMetricNames) as LatencyMetricKey[]).reduce((queries, key) => {
    const metric = config.metricNames[key] || defaultMetricNames[key];
    // 保持旧看板的 ratio 表达式：分片与 role 标签留给 parseLatencyVector 解析。
    if ('decodeSum' in metric) {
      queries[key] = `rate(${metric.decodeSum}${f}[${window}]${at}) / (rate(${metric.generationTokensSum}${f}[${window}]${at}) - rate(${metric.generationTokensCount}${f}[${window}]${at}))`;
    } else {
      queries[key] = `rate(${metric.sum}${f}[${window}]${at}) / rate(${metric.count}${f}[${window}]${at})`;
    }
    return queries;
  }, {} as Record<LatencyMetricKey, string>);
}
export const MODEL_DISCOVERY_QUERY = 'count by (model_name) (vllm:num_requests_running)';
/**
 * Prometheus 的 vLLM gauge 标签 → 当前已采集的模型列表。空闲模型也有值为 0 的 gauge。
 * 不从 LiteLLM 推断指标名。历史档案若使用逻辑别名，反向读取显式映射来确定 source_model。
 */
export function parseModelVector(raw: unknown, metricsMap: Record<string, string> = {}): Model[] {
  const names = [...new Set(promResult(raw, 'vector').map(series => series.metric.model_name).filter((name): name is string => typeof name === 'string' && !!name.trim()))].sort();
  return names.map(name => {
    const aliases = Object.entries(metricsMap).filter(([, metricsName]) => metricsName === name).map(([alias]) => alias);
    return { id: name, name, metricsName: name, provider: 'vLLM', replayModelId: aliases.length === 1 ? aliases[0] : undefined, replayError: aliases.length > 1 ? `指标模型 ${name} 对应多个回放别名，请配置唯一对应关系` : undefined };
  });
}
export async function fetchModels(config: ApiConfig = DEFAULT_API_CONFIG): Promise<Model[]> {
  return parseModelVector(await requestPrometheus(promPath(MODEL_DISCOVERY_QUERY, undefined, config)), config.modelMetricsMap);
}
/**
 * /api/litellm/model/info → 前端逻辑模型列表。
 * 同名 LiteLLM 实例合并为一个选项；id 提交回放，metricsName 用于 Prometheus 筛选。
 * 当前接受数组或 { data: [...] }；实际响应不同应在这里集中调整字段映射。
 * 不推断 litellm_params.model：其 provider 前缀/模型路径不一定等于 vLLM 标签。
 * 显式配置的映射优先于响应中的 metrics_model_name；不改变回放的逻辑模型 ID。
 */
export function adaptModels(raw: unknown, metricsMap: Record<string, string> = {}): Model[] {
  const response = raw as { data?: unknown };
  const rows = Array.isArray(raw) ? raw : response?.data;
  if (!Array.isArray(rows)) throw new Error('模型配置应为数组或 { data: [...] }，请按实际 JSON 调整 adaptModels');
  const grouped = new Map<string, Model>();
  for (const item of rows) {
    if (typeof item !== 'object' || !item) continue;
    const row = item as Record<string, any>;
    const name = row.model_name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const mapped = Object.hasOwn(metricsMap, name) ? metricsMap[name] : undefined;
    const declared = row.metrics_model_name || row.model_info?.metrics_model_name;
    const metricsName = mapped || (typeof declared === 'string' && declared.trim() ? declared : undefined);
    const provider = row.litellm_params?.custom_llm_provider;
    const previous = grouped.get(name);
    if (previous?.metricsName && metricsName && previous.metricsName !== metricsName) {
      throw new Error(`模型 ${name} 的实例具有不同指标名，请确认分组或配置 VITE_MODEL_METRICS_MAP`);
    }
    // 同名实例合并时保留已有元数据，避免最后一个实例的缺失字段覆盖正确映射。
    grouped.set(name, {
      id: name, name,
      provider: previous?.provider || (typeof provider === 'string' ? provider : undefined),
      metricsName: previous?.metricsName || metricsName
    });
  }
  return [...grouped.values()];
}
export interface ClientOptions { apiKey?: string; authHeader?: 'x-litellm-key' | 'x-api-key' | 'Authorization'; service?: 'metrics' | 'replay' | 'targets'; timeoutMs?: number; rateLimitKey?: string }
export class ApiError extends Error {
  constructor(message: string, public status: number, public payload?: any, public retryAfterMs?: number) { super(message); }
}
// 凭据仅驻留内存。身份切换清缓存，旧身份的迟到响应不能写入新缓存。
let metricsAuth: ClientOptions = {}, metricsIdentity = 0;
export function setMetricsAuth(auth: Pick<ClientOptions, 'apiKey' | 'authHeader'>): void {
  if (metricsAuth.apiKey === auth.apiKey && metricsAuth.authHeader === auth.authHeader) return;
  metricsAuth = { ...auth, service: 'metrics' }; metricsIdentity++; promCache.clear();
  for(const key of rateLimitUntil.keys())if(key==='metrics'||key.startsWith('metrics:'))rateLimitUntil.delete(key);
}
// 在途请求独立去重，不受成功缓存的 30s TTL 限制。
const promCache = new Map<string, { promise: Promise<any>; startedAt: number; expires?: number }>();
// 各指标入口与回放分别退避，避免灰度限流阻断正式查询或 Benchmark 操作。
const rateLimitUntil = new Map<string,number>();
export function request(path: string, options: RequestInit = {}, auth?: ClientOptions): Promise<any> {
  const until=rateLimitUntil.get(auth?.rateLimitKey || auth?.service || 'metrics') || 0;
  if(Date.now() < until) return Promise.reject(new ApiError('请求限流，正在等待后恢复', 429,undefined,until-Date.now()));
  return performRequest(path,options,auth);
}
export function parseTargetModels(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as { target_models?: unknown }).target_models)) {
    throw new Error('Benchmark 模型列表响应缺少 target_models 数组');
  }
  const values=(raw as { target_models: unknown[] }).target_models;
  if(values.some(value=>typeof value!=='string'||!value.trim()))throw new Error('Benchmark target_models 必须只包含非空字符串');
  return [...new Set(values as string[])];
}
export async function fetchTargetModels(path = '/api/models'): Promise<string[]> {
  return parseTargetModels(await request(path, {}, { service: 'targets' }));
}
// 由指标入口显式使用缓存，改路由前缀后仍保持 30s 去重，不依赖某一种拼写。
export function requestPrometheus(path: string, options: { timeoutMs?: number; freshAfter?: number } = {}): Promise<any> {
  const key = `${metricsIdentity}:${options.timeoutMs ?? 20000}:${path}`;
  const existing = promCache.get(key);
  if (existing && (existing.expires === undefined || existing.expires > Date.now())
    && existing.startedAt >= (options.freshAfter ?? 0)) return existing.promise;
  for (const [cachedKey, value] of promCache) if (value.expires !== undefined && value.expires <= Date.now()) promCache.delete(cachedKey);
  const rateLimitKey = 'metrics:' + path.split('?')[0].replace(/\/(?:query|query_range)$/, '');
  const promise = request(path, {}, { ...metricsAuth, service: 'metrics', timeoutMs: options.timeoutMs, rateLimitKey });
  const entry = { promise, startedAt: Date.now(), expires: undefined as number | undefined };
  promCache.set(key, entry);
  void promise.then(() => { if (promCache.get(key) === entry) entry.expires = Date.now() + 30000; },
    () => { if (promCache.get(key) === entry) promCache.delete(key); });
  return promise;
}
async function performRequest(path: string, options: RequestInit = {}, auth?: ClientOptions): Promise<any> {
  const requestMetricsIdentity = metricsIdentity;
  const controller = new AbortController();
  const timeoutMs = Math.min(300000, Math.max(1000, auth?.timeoutMs ?? 20000));
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(options.headers);
    if (options.body) headers.set('Content-Type', 'application/json');
    // 指标凭据和回放凭据由不同入口显式传入。
    if (auth?.apiKey) headers.set(auth.authHeader ?? 'x-litellm-key', auth.apiKey);
    // 相对路径走同源服务：开发/预览由 Vite 代理，生产由静态服务的反向代理转发。
    const response = await fetch(path, { ...options, headers, signal: controller.signal });
    const retryHeader=response.headers.get('Retry-After');
    const retrySeconds=retryHeader !== null && retryHeader.trim() !== '' ? Number(retryHeader) : NaN;
    const retryAfterMs=retryHeader === null ? 60000 : Math.max(1000,Number.isFinite(retrySeconds)?retrySeconds*1000:Date.parse(retryHeader)-Date.now() || 60000);
    if(response.status===429 && (auth?.service === 'replay' || requestMetricsIdentity === metricsIdentity)) rateLimitUntil.set(auth?.rateLimitKey || auth?.service || 'metrics',Date.now()+retryAfterMs);
    const raw = await response.text();
    let result;
    // 错误只展示路由，不输出查询串或认证头，便于定位后端不存在的接口。
    const route = path.split('?')[0];
    try { result = JSON.parse(raw); } catch { throw new ApiError(`HTTP ${response.status} · ${route} · 后端返回非 JSON 响应，请检查代理配置`, response.status); }
    if (!response.ok) throw new ApiError([`HTTP ${response.status}`, route, result?.error, result?.details].filter(Boolean).join(' · '), response.status,result,response.status===429?retryAfterMs:undefined);
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs / 1000}s）`);
    throw error;
  } finally { clearTimeout(timeout); }
}
// 前缀来自环境配置；URLSearchParams 编码 PromQL，不改变其聚合语义。
export function promPath(query: string, range?: TimeRange, config = DEFAULT_API_CONFIG): string {
  const params = new URLSearchParams({ query });
  if (range) {
    params.set('start', String(range.start)); params.set('end', String(range.end));
    params.set('step', String(queryTiming(range.end - range.start).step));
  }
  return `${config.prometheusPrefix}/${range ? 'query_range' : 'query'}?${params}`;
}
/** 历史窗口与回放窗口共用此入口，只是模型标签和查询时间不同。 */
export async function fetchLoad(modelName: string, range: TimeRange, labels?: Labels, config: ApiConfig = DEFAULT_API_CONFIG, options: { freshAfter?: number } = {}): Promise<LoadData> {
  const queries = loadQueries(modelName, labels);
  const keys = ['running', 'waiting'] as const;
  // 单条曲线失败时保留另一条的成功结果，错误信息交给页面展示。
  const results = await Promise.allSettled(keys.map(async key => parseMatrix(await requestPrometheus(promPath(queries[key], range, config), options))));
  const data: LoadData = { running: [], waiting: [], errors: [] };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') data[keys[i]] = r.value;
    else {
      (data.failedQueries ??= []).push(keys[i]);
      data.errors.push(`${keys[i]}：${r.reason.message}`);console.warn(r.reason);
    }
  });
  return data;
}
/** 保留失败查询的旧数据，成功查询（包括空结果）始终采用最新响应。 */
export function retainFailedLoad(previous: LoadData, next: LoadData): LoadData {
  return {
    ...next,
    running: next.failedQueries?.includes('running') ? previous.running : next.running,
    waiting: next.failedQueries?.includes('waiting') ? previous.waiting : next.waiting,
  };
}
/** 即时 query → 页面底部卡片；这些值不是历史选区的汇总结果。 */
export async function fetchMetrics(modelName: string, windowSeconds: number, config: ApiConfig = DEFAULT_API_CONFIG, options: MetricQueryOptions = {}): Promise<Metrics> {
  const queries = metricQueries(modelName, windowSeconds, config, options);
  const keys = Object.keys(queries) as MetricKey[];
  const results = await Promise.allSettled(keys.map(async key => parseLatencyVector(await requestPrometheus(promPath(queries[key], undefined, config), {freshAfter: options.freshAfter}), options.labels?.model_name || modelName, config.mixedLatencyRoleModels)));
  const data = {} as Metrics;
  results.forEach((r, i) => { data[keys[i]] = r.status === 'fulfilled' ? r.value : { error: r.reason.message }; if(r.status === 'rejected') console.warn(r.reason); });
  return data;
}
export const emptyMetrics: Metrics = { ttft: {}, e2e: {}, itl: {}, tpot: {}, qt: {} };
