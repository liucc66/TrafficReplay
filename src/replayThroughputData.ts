import type { ApiConfig } from './apiConfig';
import { parsePromValue, promDuration, promPath, promString, requestPrometheus } from './data';
import type { ReplayTrendPlan } from './replayTrendData';
import type { Point, Replay } from './types';

export type TokenDirection = 'input' | 'output';
export interface ThroughputTarget { requestedModel: string; labels: Record<string, string> }
export interface ReplayThroughputConfig {
  targets: Record<string, ThroughputTarget>;
  inputMetric: string; outputMetric: string;
  scrapeSeconds: number; windowSeconds: number; tailSeconds: number; timeoutSeconds: number;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function createReplayThroughputConfig(env: Record<string, string | undefined>, scrapeSeconds = 15): ReplayThroughputConfig {
  let raw: unknown;
  try { raw = JSON.parse(env.VITE_REPLAY_THROUGHPUT_CONFIG?.trim() || '{}'); }
  catch { throw new Error('VITE_REPLAY_THROUGHPUT_CONFIG 必须是 JSON 对象'); }
  if (!object(raw)) throw new Error('VITE_REPLAY_THROUGHPUT_CONFIG 必须是 JSON 对象');
  const allowed = ['targets', 'inputMetric', 'outputMetric', 'scrapeSeconds', 'windowSeconds', 'tailSeconds', 'timeoutSeconds'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('吞吐率配置包含未知字段');
  const seconds = (key: string, fallback: number, min: number, max: number): number => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`吞吐率 ${key} 配置无效`);
    return value;
  };
  const scrape = seconds('scrapeSeconds', scrapeSeconds, 1, 3600);
  const metric = (key: string, fallback: string) => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'string' || !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(value)) throw new Error('吞吐率指标名无效');
    return value;
  };
  const targets = Object.create(null) as Record<string, ThroughputTarget>;
  if (raw.targets !== undefined && !object(raw.targets)) throw new Error('吞吐率 targets 配置无效');
  for (const [id, target] of Object.entries(raw.targets ?? {})) {
    if (!id.trim() || !object(target) || Object.keys(target).some(key => !['requestedModel', 'labels'].includes(key))
      || typeof target.requestedModel !== 'string' || !target.requestedModel.trim()
      || target.labels !== undefined && !object(target.labels)) throw new Error('吞吐率目标映射无效');
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(target.labels ?? {})) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || key.startsWith('__') || key === 'requested_model' || typeof value !== 'string') throw new Error('吞吐率筛选标签无效');
      labels[key] = value;
    }
    targets[id] = { requestedModel: target.requestedModel, labels };
  }
  return {
    targets, scrapeSeconds: scrape, windowSeconds: Math.max(4 * scrape, seconds('windowSeconds', 60, 1, 86400)),
    tailSeconds: seconds('tailSeconds', 60, 0, 86400), timeoutSeconds: seconds('timeoutSeconds', 300, 1, 300),
    inputMetric: metric('inputMetric', 'litellm_input_tokens_metric_total'), outputMetric: metric('outputMetric', 'litellm_output_tokens_metric_total'),
  };
}

export function throughputTarget(replay: Replay, config: ReplayThroughputConfig): ThroughputTarget | undefined {
  return Object.hasOwn(config.targets, replay.modelId) ? config.targets[replay.modelId] : undefined;
}
export function throughputQuery(target: ThroughputTarget, direction: TokenDirection, config: ReplayThroughputConfig): string {
  const labels = { ...target.labels, requested_model: target.requestedModel };
  const selector = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${promString(value)}`).join(',');
  return `sum by (requested_model) (rate(${direction === 'input' ? config.inputMetric : config.outputMetric}{${selector}}[${promDuration(config.windowSeconds)}]))`;
}
export const throughputStep = (plan: ReplayTrendPlan, config: ReplayThroughputConfig) => Math.max(config.scrapeSeconds, Math.ceil((plan.range.end - plan.range.start) / 300));

export interface TokenObservation { points: Point[]; observedAt?: number; batch?: number; error?: string }
export interface ThroughputData { input: TokenObservation; output: TokenObservation; total: TokenObservation }
export const emptyThroughputData = (): ThroughputData => ({ input: { points: [] }, output: { points: [] }, total: { points: [] } });

/** 查询已按 requested_model 聚合，只接受唯一且匹配的序列；缺点补空，不插值。 */
export function parseThroughput(raw: unknown, requestedModel: string, plan: ReplayTrendPlan, step: number): TokenObservation {
  const response = raw as { status?: string; error?: string; data?: { resultType?: string; result?: { metric: Record<string, string>; values: [number, string][] }[] } };
  if (response?.status !== 'success') throw new Error(response?.error || 'Prometheus 查询失败');
  if (response.data?.resultType !== 'matrix' || !Array.isArray(response.data.result)) throw new Error('Prometheus 响应类型不匹配');
  const rows = response.data.result;
  if (rows.length > 1) throw new Error('吞吐率响应包含重复序列');
  const values = new Map<number, number | undefined>();
  for (const row of rows) {
    if (!row || !object(row.metric) || row.metric.requested_model !== requestedModel
      || Object.keys(row.metric).some(key => key !== 'requested_model') || !Array.isArray(row.values)) throw new Error('吞吐率响应模型或格式无效');
    for (const point of row.values) {
      if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || typeof point[1] !== 'string'
        || values.has(point[0]) || point[0] < plan.range.start || point[0] > plan.range.end
        || Math.abs((point[0] - plan.range.start) / step - Math.round((point[0] - plan.range.start) / step)) > 1e-6) throw new Error('吞吐率采样点无效');
      const value = parsePromValue(point[1]);
      if (value !== undefined && Number.isFinite(value) && value < 0) throw new Error('吞吐率不能为负数');
      if (value === undefined) throw new Error('吞吐率采样值无效');
      values.set(point[0], Number.isFinite(value) ? value : undefined);
    }
  }
  const points: Point[] = [];
  if (rows.length) for (let timestamp = plan.range.start; timestamp <= plan.range.end; timestamp += step) points.push({ timestamp, value: values.get(timestamp) });
  return { points, observedAt: plan.evaluatedAt };
}

export async function fetchThroughput(target: ThroughputTarget, direction: TokenDirection, plan: ReplayTrendPlan, config: ReplayThroughputConfig, api: ApiConfig, batchStartedAt = Date.now()): Promise<TokenObservation> {
  const step = throughputStep(plan, config);
  const url = new URL(promPath(throughputQuery(target, direction, config), plan.range, api), 'http://dashboard.local');
  url.searchParams.set('step', String(step));
  const raw = await requestPrometheus(url.pathname + url.search, {
    timeoutMs: config.timeoutSeconds * 1000,
    // 固定终点的重试也必须在本轮发起；不能把上轮缓存分量伪装成同轮响应。
    freshAfter: batchStartedAt,
  });
  return parseThroughput(raw, target.requestedModel, plan, step);
}

/** 失败保留各自最后成功结果；总和只能来自同一轮成功响应，不能混用旧分量。 */
export function applyThroughputResult(previous: ThroughputData, direction: TokenDirection, next: TokenObservation, batch: number): ThroughputData {
  const data = { ...previous, [direction]: next.error ? { ...previous[direction], error: next.error } : { ...next, batch } };
  if (data.input.batch === batch && data.output.batch === batch && !data.input.error && !data.output.error) {
    const output = new Map(data.output.points.map(point => [point.timestamp, point.value]));
    data.total = { batch, observedAt: data.input.observedAt, points: data.input.points.map(point => {
      const other = output.get(point.timestamp);
      const sum = point.value !== undefined && other !== undefined ? point.value + other : undefined;
      return { timestamp: point.timestamp, value: sum !== undefined && Number.isFinite(sum) ? sum : undefined };
    }) };
  } else data.total = { ...previous.total, error: '总吞吐等待同轮输入与输出数据' };
  return data;
}
