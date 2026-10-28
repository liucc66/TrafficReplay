import { isTerminalReplay } from './replay';
import { metricQueries, parsePromValue, promPath, requestPrometheus } from './data';
import type { ApiConfig } from './apiConfig';
import type { ReplayLatencyConfig } from './replayLatencyData';
import type { Point, Replay, Series, TimeRange } from './types';

export type ReplayTrendConfig = ReplayLatencyConfig;

export interface ReplayTrendPlan {
  range: TimeRange;
  evaluatedAt: number;
  settleAfter?: number;
}

export interface ReplayTrendData {
  series: Series[];
  observedAt?: number;
  error?: string;
}

export const emptyReplayTrendData = (): ReplayTrendData => ({ series: [] });

/** 完整 rate 窗口不能覆盖回放前的流量；短任务没有足够观测时段时明确结束等待。 */
export function replayTrendHasInsufficientWindow(replay: Replay, config: ReplayTrendConfig, tailSeconds = 2 * config.scrapeSeconds): boolean {
  return replay.startedAt !== undefined && isTerminalReplay(replay.status) && replay.finishedAt !== undefined
    && Math.ceil(replay.finishedAt + tailSeconds) < Math.ceil(replay.startedAt + config.windowSeconds);
}

export function replayTrendPlan(replay: Replay, now: number, config: ReplayTrendConfig, tailSeconds = 2 * config.scrapeSeconds): ReplayTrendPlan | undefined {
  if (replay.startedAt === undefined) return;
  const finalTime = isTerminalReplay(replay.status) && replay.finishedAt !== undefined
    ? Math.ceil(replay.finishedAt + tailSeconds) : undefined;
  const evaluatedAt = Math.floor(Math.min(now, finalTime ?? now));
  const start = Math.ceil(replay.startedAt + config.windowSeconds);
  if (evaluatedAt < start) return;
  return {
    range: { start, end: evaluatedAt },
    evaluatedAt,
    settleAfter: finalTime === undefined ? undefined : finalTime + 30,
  };
}

/** 使用发起时间判定，休眠或慢响应不能将未覆盖尾部的查询误判为最终观测。 */
export function replayTrendCanSettle(plan: ReplayTrendPlan, requestedAt: number): boolean {
  return plan.settleAfter !== undefined && requestedAt >= plan.settleAfter && plan.range.end >= plan.settleAfter - 30;
}

export function replayTrendQuery(replay: Replay, config: ReplayTrendConfig, api: ApiConfig): string {
  // 与即时 TTFT 卡片共用 histogram 配置及表达式；趋势统一转换成毫秒。
  return `1000 * (${metricQueries(replay.metricsName, config.windowSeconds, api, { labels: replay.metricsLabels }).ttft})`;
}

interface PromSeries { metric: Record<string, string>; values: [number, string][] }
interface SampleGrid { range: TimeRange; step: number }

function responseMatrix(raw: unknown): PromSeries[] {
  const response = raw as { status?: string; error?: string; data?: { resultType?: string; result?: PromSeries[] } };
  if (response?.status !== 'success') throw new Error(response?.error || 'Prometheus 查询失败');
  if (response.data?.resultType !== 'matrix' || !Array.isArray(response.data.result)) throw new Error('Prometheus 响应类型不匹配');
  for (const row of response.data.result) {
    if (!row?.metric || typeof row.metric !== 'object' || Array.isArray(row.metric)
      || Object.values(row.metric).some(value => typeof value !== 'string') || !Array.isArray(row.values)) {
      throw new Error('首 Token 趋势响应格式无效');
    }
    const timestamps = new Set<number>();
    for (const point of row.values) {
      if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || typeof point[1] !== 'string' || timestamps.has(point[0])) {
        throw new Error('首 Token 趋势采样点无效');
      }
      timestamps.add(point[0]);
    }
  }
  return response.data.result;
}

/** 与延迟卡片一致：忽略空闲 engine 的 NaN，其余 engine 按 role 求均值。 */
function averagePoints(rows: PromSeries[], grid?: SampleGrid): Point[] {
  const values = new Map<number, number[]>();
  for (const row of rows) for (const [timestamp, raw] of row.values) {
    if (grid && (timestamp < grid.range.start || timestamp > grid.range.end
      || Math.abs((timestamp - grid.range.start) / grid.step - Math.round((timestamp - grid.range.start) / grid.step)) > 1e-6)) {
      throw new Error('首 Token 趋势采样点超出查询网格');
    }
    const value = parsePromValue(raw);
    if (value !== undefined && Number.isFinite(value) && value < 0) throw new Error('首 Token 延迟不能为负数');
    const list = values.get(timestamp) ?? [];
    if (value !== undefined && !Number.isNaN(value)) list.push(value);
    values.set(timestamp, list);
  }
  // query_range 可以省略完全缺失的时间点；补空点防止折线跨过停采区间。
  if (grid) for (let timestamp = grid.range.start; timestamp <= grid.range.end; timestamp += grid.step) {
    if (!values.has(timestamp)) values.set(timestamp, []);
  }
  return [...values].sort(([a], [b]) => a - b).map(([timestamp, list]) => {
    const value = list.length ? list.reduce((a, b) => a + b, 0) / list.length : undefined;
    return { timestamp, value: value !== undefined && Number.isFinite(value) ? value : undefined };
  });
}

export function parseReplayTrend(raw: unknown, modelName: string, mixedRoleModels: string[] = ['deepseek'], observedAt?: number, grid?: SampleGrid): ReplayTrendData {
  const rows = responseMatrix(raw);
  if (rows.some(row => row.metric.model_name && row.metric.model_name !== modelName)) {
    throw new Error('趋势响应包含其他模型，请检查 PromQL 模型筛选');
  }
  const mixed = mixedRoleModels.some(token => modelName.toLocaleLowerCase().includes(token.toLocaleLowerCase()));
  const groups = new Map<string, PromSeries[]>();
  for (const row of rows) {
    const role = mixed ? '' : row.metric.role || '';
    const grouped = groups.get(role) ?? [];
    grouped.push(row); groups.set(role, grouped);
  }
  const series = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([role, grouped]) => ({
    id: JSON.stringify([modelName, role]),
    name: modelName + (role ? ` · ${role}` : ''),
    points: averagePoints(grouped, grid),
  }));
  return { series, observedAt };
}

export async function fetchReplayTrend(replay: Replay, plan: ReplayTrendPlan, config: ReplayTrendConfig, api: ApiConfig): Promise<ReplayTrendData> {
  const step = Math.max(config.scrapeSeconds, Math.ceil((plan.range.end - plan.range.start) / 300));
  const url = new URL(promPath(replayTrendQuery(replay, config, api), plan.range, api), 'http://dashboard.local');
  url.searchParams.set('step', String(step));
  return parseReplayTrend(await requestPrometheus(url.pathname + url.search, { freshAfter: plan.settleAfter !== undefined && Date.now() / 1000 >= plan.settleAfter ? plan.settleAfter * 1000 : undefined }), replay.metricsLabels?.model_name || replay.metricsName,
    api.mixedLatencyRoleModels, plan.evaluatedAt, { range: plan.range, step });
}

export function retainReplayTrend(previous: ReplayTrendData, next: ReplayTrendData): ReplayTrendData {
  return next.error ? { ...previous, error: next.error } : next;
}
