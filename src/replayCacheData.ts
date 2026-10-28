import type { ApiConfig } from './apiConfig';
import { parsePromValue, promDuration, promPath, requestPrometheus, selector } from './data';
import { isTerminalReplay } from './replay';
import type { Replay, Series, TimeRange } from './types';

export interface ReplayCacheConfig {
  kvMetric: string; kvUnit: 'ratio' | 'percent'; hitsMetric: string; queriesMetric: string;
  counterUnit: 'unknown' | 'tokens' | 'blocks' | 'requests'; windowSeconds: number;
  scrapeSeconds: number; labels: Record<string, string>;
}
export type CacheMetricKey = 'kv' | 'hitRate' | 'hitTokens';
export interface CacheResult { series: Series[]; value?: number; name?: string; observedAt?: number; error?: string }
export type CacheData = Record<CacheMetricKey, { current: CacheResult; trend: CacheResult }>;
export interface CachePlan { range: TimeRange; rateRange?: TimeRange; evaluatedAt: number; terminal: boolean; settleAfter?: number }
export const emptyCacheData = (): CacheData => ({ kv: { current: { series: [] }, trend: { series: [] } }, hitRate: { current: { series: [] }, trend: { series: [] } }, hitTokens: { current: { series: [] }, trend: { series: [] } } });

/** 当前部署已确认 hits/queries 按 token 计数；其他部署可显式覆盖单位，不按指标后缀猜测。 */
export function createReplayCacheConfig(env: Record<string, string | undefined>, scrapeSeconds: number): ReplayCacheConfig {
  const defaults: ReplayCacheConfig = {
    kvMetric: 'vllm:kv_cache_usage_perc', kvUnit: 'ratio',
    hitsMetric: 'vllm:prefix_cache_hits_total', queriesMetric: 'vllm:prefix_cache_queries_total',
    counterUnit: 'tokens', windowSeconds: 60, scrapeSeconds, labels: {},
  };
  let raw: unknown = {};
  try { raw = JSON.parse(env.VITE_REPLAY_CACHE_CONFIG?.trim() || '{}'); }
  catch { throw new Error('VITE_REPLAY_CACHE_CONFIG 必须是 JSON 对象'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('VITE_REPLAY_CACHE_CONFIG 必须是 JSON 对象');
  const fields = ['kvMetric', 'kvUnit', 'hitsMetric', 'queriesMetric', 'counterUnit', 'windowSeconds', 'labels'];
  if (Object.keys(raw).some(key => !fields.includes(key))) throw new Error('VITE_REPLAY_CACHE_CONFIG 含未知配置项');
  const config = { ...defaults, ...raw } as ReplayCacheConfig;
  for (const key of ['kvMetric', 'hitsMetric', 'queriesMetric'] as const) {
    if (typeof config[key] !== 'string' || !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(config[key])) throw new Error(`VITE_REPLAY_CACHE_CONFIG.${key} 应为合法指标名`);
  }
  if (!['ratio', 'percent'].includes(config.kvUnit) || !['unknown', 'tokens', 'blocks', 'requests'].includes(config.counterUnit)) throw new Error('VITE_REPLAY_CACHE_CONFIG 的单位配置无效');
  if (!Number.isSafeInteger(config.windowSeconds) || config.windowSeconds <= 0) throw new Error('VITE_REPLAY_CACHE_CONFIG.windowSeconds 应为正整数秒');
  if (!config.labels || typeof config.labels !== 'object' || Array.isArray(config.labels) || Object.entries(config.labels).some(([key, value]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || key === '__name__' || typeof value !== 'string' || !value)) throw new Error('VITE_REPLAY_CACHE_CONFIG.labels 应为有效标签对象');
  config.windowSeconds = Math.max(config.windowSeconds, 4 * scrapeSeconds);
  return config;
}

/** KV 即刻观测；rate 等完整窗口，避免任何曲线点使用回放前计数。 */
export function replayCachePlan(replay: Replay, now: number, config: ReplayCacheConfig): CachePlan | undefined {
  if (replay.startedAt === undefined) return;
  const finalTime = isTerminalReplay(replay.status) && replay.finishedAt !== undefined ? Math.ceil(replay.finishedAt + 2 * config.scrapeSeconds) : undefined;
  const evaluatedAt = Math.floor(Math.min(now, finalTime ?? now));
  const start = Math.ceil(replay.startedAt);
  if (evaluatedAt < start) return;
  const rateStart = Math.ceil(replay.startedAt + config.windowSeconds);
  return { range: { start, end: evaluatedAt }, evaluatedAt, terminal: isTerminalReplay(replay.status),
    rateRange: rateStart <= evaluatedAt ? { start: rateStart, end: evaluatedAt } : undefined,
    settleAfter: finalTime === undefined ? undefined : finalTime + 30 };
}

export function cacheQueries(replay: Replay, config: ReplayCacheConfig): Record<CacheMetricKey, string> {
  const labels = { ...replay.metricsLabels };
  for (const [key, value] of Object.entries(config.labels)) {
    const target = labels[key] ?? (key === 'model_name' ? replay.metricsName : undefined);
    if (target !== undefined && target !== value) throw new Error('缓存筛选标签与回放目标冲突');
    labels[key] = value;
  }
  const f = selector(replay.metricsName, labels);
  const gauge = `${config.kvMetric}${f}`;
  // 不允许 Prometheus 的默认 lookback 将回放前或已陈旧的 gauge 当作当前值。
  const kv = `(${gauge} and (timestamp(${gauge}) >= ${replay.startedAt}) and (timestamp(${gauge}) >= (time() - ${2 * config.scrapeSeconds}))) * ${config.kvUnit === 'ratio' ? 100 : 1}`;
  const rate = (metric: string) => `sum(rate(${metric}${f}[${promDuration(config.windowSeconds)}]))`;
  const hits = rate(config.hitsMetric), queries = rate(config.queriesMetric);
  return { kv, hitRate: `(100 * ${hits} / ${queries}) and (${queries} > 0)`, hitTokens: hits };
}

/**
 * KV 卡片从趋势区间结果推导，不再单独单点求值：与曲线严格一致，闸门失败只回退到前一个有效点。
 * 进行中取各实例最后有效点的最大值；终态取全程峰值（跨序列与并列均取更早时刻，即首次达到峰值的时刻）。
 */
export function deriveKvCurrent(trend: CacheResult, peak: boolean): CacheResult {
  if (trend.error) return { series: [], error: trend.error };
  const picks = trend.series.flatMap(s => {
    const defined = s.points.filter(p => p.value !== undefined && Number.isFinite(p.value));
    if (!defined.length) return [];
    const point = peak ? defined.reduce((a, b) => b.value! > a.value! ? b : a) : defined[defined.length - 1];
    return [{ id: s.id, name: s.name, point: { timestamp: point.timestamp, value: point.value! } }];
  });
  if (!picks.length) return { series: [] };
  const best = picks.sort((a, b) => b.point.value - a.point.value || a.point.timestamp - b.point.timestamp)[0];
  return { series: picks.map(pick => ({ id: pick.id, name: pick.name, points: [pick.point] })), value: best.point.value, name: best.name, observedAt: best.point.timestamp };
}

interface PromSeries { metric: Record<string, string>; value?: [number, string]; values?: [number, string][] }
/** 保留所有真实标签作为身份；不按 model/role 合并不同实例。 */
export function parseCacheResult(raw: unknown, key: CacheMetricKey, type: 'vector' | 'matrix', evaluatedAt: number, grid?: TimeRange & { step: number }): CacheResult {
  const response = raw as { status?: string; error?: string; data?: { resultType?: string; result?: PromSeries[] } };
  if (response?.status !== 'success') throw new Error(response?.error || 'Prometheus 查询失败');
  if (response.data?.resultType !== type || !Array.isArray(response.data.result)) throw new Error('Prometheus 响应类型不匹配');
  if (key !== 'kv' && response.data.result.length > 1) throw new Error('卡片查询应在 PromQL 中聚合为单个结果');
  const identities = new Set<string>();
  const series = response.data.result.map(row => {
    const labels = Object.entries(row.metric).filter(([label]) => label !== '__name__').sort(([a], [b]) => a.localeCompare(b));
    const id = JSON.stringify(labels);
    if (identities.has(id)) throw new Error('缓存指标包含重复序列');
    identities.add(id);
    const name = key === 'kv' ? labels.filter(([label]) => label !== 'model_name').map(([label, value]) => `${label}=${value}`).join(' · ') || labels.map(([label, value]) => `${label}=${value}`).join(' · ') || 'KV Cache' : key === 'hitRate' ? 'Prefix cache' : 'Cache hits';
    const samples = type === 'matrix' ? row.values ?? [] : row.value ? [row.value] : [];
    let points = samples.map(([timestamp, rawValue]) => {
      const parsed = parsePromValue(rawValue);
      const value = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
      if (!Number.isFinite(timestamp)) throw new Error('缓存指标时间戳无效');
      // 不裁剪错误单位导致的 6400%，以免掩盖配置或计数器问题。
      if (value !== undefined && (value < 0 || key !== 'hitTokens' && value > 100 + 1e-6)) throw new Error('缓存指标超出有效范围，请检查单位与计数器');
      return { timestamp, value };
    }).sort((a, b) => a.timestamp - b.timestamp);
    // Prometheus 省略无样本的求值点；填入断点，防止折线跨越停采区间。
    if (grid) {
      const values = new Map(points.map(p => [p.timestamp, p.value]));
      points = [];
      for (let timestamp = grid.start; timestamp <= grid.end; timestamp += grid.step) points.push({ timestamp, value: values.get(timestamp) });
    }
    return { id, name, points };
  });
  const latest = series.flatMap(s => {
    const point = s.points.at(-1);
    return point?.value !== undefined ? [{ value: point.value, name: s.name }] : [];
  }).sort((a, b) => b.value - a.value)[0];
  return { series, value: latest?.value, name: latest?.name, observedAt: evaluatedAt };
}

export async function fetchReplayCache(replay: Replay, plan: CachePlan, config: ReplayCacheConfig, api: ApiConfig): Promise<CacheData> {
  const data = emptyCacheData();
  const freshAfter = plan.settleAfter !== undefined && Date.now() / 1000 >= plan.settleAfter ? plan.settleAfter * 1000 : undefined;
  const queries = cacheQueries(replay, config);
  // 保留已有 Prometheus 缓存与去重；显式步长限制为约 300 点且不密于采集间隔。
  const fetchParsed = async (key: CacheMetricKey, query: string, range: TimeRange) => {
    const url = new URL(promPath(query, range, api), 'http://dashboard.local');
    const step = Math.max(config.scrapeSeconds, Math.ceil((range.end - range.start) / 300));
    url.searchParams.set('step', String(step));
    return parseCacheResult(await requestPrometheus(url.pathname + url.search, {freshAfter}), key, 'matrix', plan.evaluatedAt, { ...range, step });
  };
  // KV 只发趋势区间查询；卡片由该结果推导，与曲线严格一致，终态取全程峰值。
  const kvQuery = (async () => {
    try {
      const trend = await fetchParsed('kv', queries.kv, plan.range);
      data.kv.trend = trend;
      data.kv.current = deriveKvCurrent(trend, plan.terminal);
    } catch (error) {
      const message = (error as Error).message;
      data.kv.trend = { series: [], error: message };
      data.kv.current = { series: [], error: message };
    }
  })();
  // 命中率/token 卡保持 start=end 的单点求值，兼容拒绝 @ 修饰符的即时查询代理；终态仍查询原任务时间。
  const rateKeys: CacheMetricKey[] = plan.rateRange && config.counterUnit !== 'unknown'
    ? ['hitRate' as const, ...(config.counterUnit === 'tokens' ? ['hitTokens' as const] : [])] : [];
  await Promise.all([kvQuery, ...rateKeys.flatMap(key => (['current', 'trend'] as const).map(async kind => {
    const range = kind === 'current' ? { start: plan.evaluatedAt, end: plan.evaluatedAt } : plan.rateRange!;
    try { data[key][kind] = await fetchParsed(key, queries[key], range); }
    catch (error) { data[key][kind] = { series: [], error: (error as Error).message }; }
  }))]);
  return data;
}

export function retainReplayCache(previous: CacheData, next: CacheData): CacheData {
  return Object.fromEntries((Object.keys(next) as CacheMetricKey[]).map(key => [key, Object.fromEntries((['current', 'trend'] as const).map(kind => [kind, next[key][kind].error ? { ...previous[key][kind], error: next[key][kind].error } : next[key][kind]]))])) as CacheData;
}
