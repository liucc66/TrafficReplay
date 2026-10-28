import { useEffect, useRef, useState } from 'react';
import type { ApiConfig } from './apiConfig';
import { emptyMetrics, fetchMetrics, promDuration } from './data';
import LatencyCard, { LATENCY_CARDS } from './LatencyCard';
import { translate, type Language } from './i18n';
import { isTerminalReplay } from './replay';
import { replayLatencyWindow, retainReplayLatency, type ReplayLatencyConfig, type ReplayLatencyMetrics, type ReplayLatencyWindow } from './replayLatencyData';
import { fullDateTime } from './time';
import type { Metrics, Replay } from './types';

export default function ReplayLatency({ replay, api, config, language, refreshToken }: {
  replay?: Replay; api: ApiConfig; config: ReplayLatencyConfig; language: Language; refreshToken: number;
}) {
  const t = (text: string, values?: Record<string, string | number>) => translate(language, text, values);
  const [metrics, setMetrics] = useState<ReplayLatencyMetrics>(emptyMetrics);
  const [loading, setLoading] = useState(false);
  const [window, setWindow] = useState<ReplayLatencyWindow>();
  const [settled, setSettled] = useState(false);
  const currentTask = useRef(replay); currentTask.current = replay;
  const labelKey = JSON.stringify(Object.entries(replay?.metricsLabels || {}).sort(([a], [b]) => a.localeCompare(b)));
  const terminal = !!replay && isTerminalReplay(replay.status);

  useEffect(() => {
    setMetrics(emptyMetrics); setWindow(undefined); setSettled(false); setLoading(false);
  }, [replay?.id, replay?.startedAt, replay?.metricsName, labelKey]);

  useEffect(() => {
    if (!replay || replay.startedAt === undefined) return;
    let live = true, busy = false, done = false;
    setSettled(false);
    const load = async () => {
      const task = currentTask.current;
      if (!live || busy || done || document.hidden || task?.id !== replay.id) return;
      const requestedAt = Date.now() / 1000;
      const plan = replayLatencyWindow(task, requestedAt, config);
      if (!plan) return;
      busy = true; setLoading(true); setWindow(plan);
      try {
        const data: Metrics = await fetchMetrics(task.metricsName, plan.windowSeconds, api, { labels: task.metricsLabels, evaluatedAt: plan.evaluatedAt, freshAfter: plan.settleAfter !== undefined && requestedAt >= plan.settleAfter ? plan.settleAfter * 1000 : undefined });
        if (!live) return;
        setMetrics(previous => retainReplayLatency(previous, data, plan.evaluatedAt));
        if (plan.settleAfter !== undefined && requestedAt >= plan.settleAfter && Object.values(data).every(metric => !metric.error)) {
          done = true; setSettled(true);
        }
      } catch (error) {
        if (live) {
          const data = Object.fromEntries(LATENCY_CARDS.map(card => [card.key, { error: (error as Error).message }])) as Metrics;
          setMetrics(previous => retainReplayLatency(previous, data, plan.evaluatedAt));
        }
      } finally { busy = false; if (live) setLoading(false); }
    };
    void load();
    const timer = globalThis.setInterval(() => void load(), 30000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [replay?.id, replay?.startedAt, replay?.finishedAt, replay?.metricsName, labelKey, terminal, api, config, refreshToken]);

  const emptyNote = t(!replay ? '等待创建回放任务' : replay.startedAt === undefined
    ? terminal ? '任务已结束，未开始打流' : '等待实际打流开始时间'
    : !window ? '采集中 · 等待回放后的采集样本' : '暂无样本 · 检查指标名与模型标签');
  const hasErrors = Object.values(metrics).some(metric => metric.error);
  return <section className="latency-section replay-latency-section" aria-label={t('回放实时延迟')}>
    <div className="section-title"><div><h2>{t('回放实时延迟')}</h2><span>REPLAY LATENCY</span></div>
      <span className="section-hint">{t('近期平均 · 回溯 {window} · 每 30s 更新', { window: promDuration(window?.windowSeconds || config.windowSeconds) })}</span>
    </div>
    <div className="replay-latency-context">
      <span>{replay ? replay.metricsLabels?.model_name || replay.metricsName : t('等待创建回放任务')}</span>
      {replay && <code title={replay.id}>{replay.id}</code>}
      <span role="status">{hasErrors ? t('部分指标查询失败，显示最近成功数据') : settled ? t('最终观测已固定') : terminal && replay?.startedAt !== undefined ? t('任务已结束，正在补采尾部指标') : loading ? t('查询中…') : window ? t('持续观测中') : emptyNote}</span>
    </div>
    {replay && <div className="replay-latency-source">{t('来源历史：{start} — {end}', { start: fullDateTime(replay.source.start), end: fullDateTime(replay.source.end) })}</div>}
    <div className="metrics-grid">{LATENCY_CARDS.map(card => <LatencyCard key={card.key} metricKey={card.key} metric={metrics[card.key]} loading={loading} language={language} kind="replay" emptyNote={emptyNote} observedAt={metrics[card.key].observedAt}/>)}</div>
    <p className="replay-latency-note">{t('展示回放目标部署的近期平均延迟，可能包含其他业务流量；采集与缓存会带来更新延迟。')}</p>
  </section>;
}
