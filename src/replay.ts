import type { Replay, ReplaySpeed } from './types';

const STATUSES = new Set<Replay['status']>(['queued','preparing','running','draining','cancelling','succeeded','failed','cancelled']);

export function isTerminalReplay(status: Replay['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function replaySpeed(value: unknown): ReplaySpeed | undefined {
  if (value === 'burst') return value;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 创建和状态响应共用适配；未知/省略的字段不覆盖已经收到的有效数据。 */
export function applyReplayResponse(raw: unknown, previous: Replay, receivedAt = Date.now() / 1000, metricsMap: Record<string, string> = {}): Replay {
  const response = object(raw);
  if (!response || !STATUSES.has(response.status as Replay['status'])) throw new Error('未知回放状态');
  if (typeof response.replay_id === 'string' && response.replay_id !== previous.id) throw new Error('回放任务 ID 不匹配');
  const revision=count(response.revision);
  if (revision !== undefined && previous.revision !== undefined && revision < previous.revision) return previous;
  if (isTerminalReplay(previous.status) && response.status !== previous.status) return previous;
  const progress = object(response.progress);
  const labels = object(object(response.target)?.metrics_labels);
  let metricsLabels = labels && Object.values(labels).every(value => typeof value === 'string') ? labels as Record<string, string> : previous.metricsLabels;
  // 轮询和取消响应都可能把 LiteLLM 别名返回为 model_name，终态同样需要映射。
  if (metricsLabels?.model_name === previous.modelId && metricsMap[previous.modelId]) {
    metricsLabels = { ...metricsLabels, model_name: metricsMap[previous.modelId] };
  }
  const status=previous.status === 'cancelling' && !isTerminalReplay(response.status as Replay['status']) ? 'cancelling' : response.status as Replay['status'];
  return {
    ...previous,
    status,
    speed: replaySpeed(response.speed) ?? previous.speed,
    cancellable: status === 'cancelling' || isTerminalReplay(status) ? false : typeof response.cancellable === 'boolean' ? response.cancellable : previous.cancellable,
    cancelRequestedAt: timestamp(response.cancel_requested_at) ?? previous.cancelRequestedAt,
    revision: revision ?? previous.revision,
    startedAt: timestamp(response.started_at) ?? previous.startedAt,
    finishedAt: timestamp(response.finished_at) ?? previous.finishedAt,
    requestCount: (progress?.ready === false ? undefined : count(progress?.total)) ?? count(response.request_count) ?? previous.requestCount,
    sentCount: monotonicCount(count(progress?.sent) ?? count(response.sent_count), previous.sentCount),
    completedCount: monotonicCount(count(progress?.completed) ?? count(response.completed_count), previous.completedCount),
    failedCount: monotonicCount(count(response.failed_count), previous.failedCount),
    skippedCount: count(progress?.skipped) ?? count(response.skipped_count) ?? previous.skippedCount,
    metricsLabels,
    statusUpdatedAt: receivedAt,
    statusError: undefined,
    taskError: typeof response.error === 'string' ? response.error : undefined,
  };
}

function monotonicCount(value: number | undefined, previous: number | undefined) {
  return value === undefined ? previous : previous === undefined ? value : Math.max(value, previous);
}

/** 活动任务可以独立恢复；创建接口的旧响应可用请求上下文补齐字段。 */
export function restoreReplay(raw: unknown, metricsMap: Record<string,string> = {}, fallback?: Replay): Replay {
  const response=object(raw);
  const id=response?.replay_id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('创建回放响应缺少 replay_id，请确认后端契约');
  const same=fallback?.id === id || fallback?.id === '' ? fallback : undefined;
  const modelId=typeof response?.target_model === 'string' ? response.target_model : typeof response?.model_id === 'string' ? response.model_id : same?.modelId;
  const sourceModelId=typeof response?.source_model === 'string' ? response.source_model : same?.sourceModelId ?? modelId;
  const start=timestamp(response?.start_time) ?? same?.source.start;
  const end=timestamp(response?.end_time) ?? same?.source.end;
  if (!modelId || start === undefined || end === undefined || end <= start) throw new Error('任务响应缺少有效模型或历史区间');
  let labels=object(object(response?.target)?.metrics_labels);
  // 兼容旧 Benchmark 将逻辑别名直接作为 model_name 的响应；显式部署标签仍优先。
  if (labels?.model_name === modelId && metricsMap[modelId]) labels={...labels,model_name:metricsMap[modelId]};
  const metricsName=typeof labels?.model_name === 'string' ? labels.model_name : metricsMap[modelId] || same?.metricsName || modelId;
  const base: Replay={...same,id,modelId,sourceModelId,sourceModelName:same?.sourceModelName || sourceModelId,modelName:same?.modelName || modelId,metricsName,source:{start,end},status:same?.status ?? 'queued'};
  return applyReplayResponse({...response,target:{metrics_labels:labels},status:response?.status ?? 'queued'},base);
}

/** 100% 表示处理结束的比例，任务是否成功仍由 status 决定。 */
export function replayPercent(replay: Pick<Replay, 'requestCount' | 'completedCount'>): number | undefined {
  if (replay.requestCount === undefined || replay.requestCount <= 0 || replay.completedCount === undefined) return undefined;
  return Math.min(100, Math.max(0, replay.completedCount / replay.requestCount * 100));
}
