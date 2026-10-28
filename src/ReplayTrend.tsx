import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiConfig } from './apiConfig';
import CacheTrend from './CacheTrend';
import { promDuration } from './data';
import { localizeMessage, translate, type Language } from './i18n';
import { isTerminalReplay } from './replay';
import { emptyReplayTrendData, fetchReplayTrend, replayTrendCanSettle, replayTrendHasInsufficientWindow, replayTrendPlan, retainReplayTrend, type ReplayTrendConfig, type ReplayTrendData, type ReplayTrendPlan } from './replayTrendData';
import { fullDateTime } from './time';
import type { Replay } from './types';

export default function ReplayTrend({ replay, api, config, language, refreshToken }: {
  replay?: Replay; api: ApiConfig; config: ReplayTrendConfig; language: Language; refreshToken: number;
}) {
  const t = (text: string, values?: Record<string, string | number>) => translate(language, text, values);
  const [data, setData] = useState<ReplayTrendData>(emptyReplayTrendData);
  const [plan, setPlan] = useState<ReplayTrendPlan>();
  const [loading, setLoading] = useState(false);
  const [settled, setSettled] = useState(false);
  const [relative, setRelative] = useState(true);
  const currentTask = useRef(replay); currentTask.current = replay;
  const labels = JSON.stringify(Object.entries(replay?.metricsLabels || {}).sort(([a], [b]) => a.localeCompare(b)));
  const terminal = !!replay && isTerminalReplay(replay.status);
  const insufficientWindow = !!replay && replayTrendHasInsufficientWindow(replay, config);

  useEffect(() => { setData(emptyReplayTrendData()); setPlan(undefined); setSettled(false); setLoading(false); }, [replay?.id, replay?.startedAt, replay?.metricsName, labels]);

  useEffect(() => {
    setSettled(false); setLoading(false);
    if (!replay || replay.startedAt === undefined || insufficientWindow) return;
    let live = true, busy = false, done = false;
    let startTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const load = async () => {
      const task = currentTask.current;
      if (!live || busy || done || document.hidden || task?.id !== replay.id) return;
      const requestedAt = Date.now() / 1000;
      const nextPlan = replayTrendPlan(task, requestedAt, config);
      if (!nextPlan) {
        clearTimeout(startTimer);
        const firstAt = Math.ceil(task.startedAt! + config.windowSeconds);
        startTimer = globalThis.setTimeout(() => void load(), Math.max(1, Math.min(30000, firstAt * 1000 - Date.now())));
        return;
      }
      clearTimeout(startTimer);
      busy = true; setLoading(true); setPlan(nextPlan);
      try {
        const next = await fetchReplayTrend(task, nextPlan, config, api);
        if (!live) return;
        setData(previous => retainReplayTrend(previous, next));
        if (replayTrendCanSettle(nextPlan, requestedAt)) { done = true; setSettled(true); }
      } catch (error) {
        if (live) {
          setData(previous => retainReplayTrend(previous, { series: [], error: (error as Error).message }));
        }
      } finally { busy = false; if (live) setLoading(false); }
    };
    void load();
    const timer = globalThis.setInterval(() => void load(), 30000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { live = false; clearTimeout(startTimer); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [replay?.id, replay?.startedAt, replay?.finishedAt, replay?.metricsName, labels, terminal, insufficientWindow, api, config, refreshToken]);

  const range = useMemo(() => replay?.startedAt !== undefined
    ? { start: replay.startedAt, end: Math.max(replay.startedAt + config.scrapeSeconds, plan?.range.end ?? replay.startedAt + config.windowSeconds) }
    : { start: 0, end: 60 }, [plan, replay?.startedAt, config.scrapeSeconds, config.windowSeconds]);
  const hasSamples = data.series.some(series => series.points.some(point => Number.isFinite(point.value)));
  const baseNote = !replay ? '等待创建回放任务' : replay.startedAt === undefined
    ? terminal ? '任务已结束，未开始打流' : '等待实际打流开始时间'
    : insufficientWindow ? '任务观测时段不足完整统计窗口'
    : !plan ? '采集中 · 等待完整统计窗口' : '暂无样本 · 检查指标、标签与采集状态';
  const errorNote = t(data.observedAt === undefined ? '查询失败 · 查看详情' : '查询失败 · 显示最近成功数据');
  const emptyNote = data.error ? errorNote : loading && data.observedAt === undefined ? t('查询中…') : t(baseNote);
  const labelsText = Object.entries(replay?.metricsLabels || {}).filter(([key]) => key !== 'model_name').map(([key, value]) => `${key}=${value}`).join(' · ');

  return <section className="replay-trend-section" aria-label={t('回放历史趋势')}>
    <div className="section-title"><div><h2>{t('回放历史趋势')}</h2><span>REPLAY TRENDS</span></div><span className="section-hint">{t('统计窗口 {window} · 每 30s 更新', { window: promDuration(config.windowSeconds) })}</span></div>
    <div className="replay-trend-context"><span>{replay ? replay.metricsLabels?.model_name || replay.metricsName : t('等待创建回放任务')}</span>{replay && <code title={replay.id}>{replay.id}</code>}<span role="status">{data.error ? errorNote : insufficientWindow ? t(baseNote) : settled ? t('最终观测已固定') : terminal && replay?.startedAt !== undefined ? t('任务已结束，正在补采尾部指标') : loading ? t('查询中…') : hasSamples ? t('持续观测中') : t(baseNote)}</span></div>
    {replay && <div className="replay-latency-source">{labelsText || t('仅按模型筛选，可能包含其他部署')}<br/>{replay.startedAt !== undefined ? t('趋势起点：{time}', { time: fullDateTime(replay.startedAt) }) : t(baseNote)}</div>}
    <div className="replay-trend-toolbar"><span>{t('曲线以实际打流时间为起点')}</span><label className="relative"><input type="checkbox" checked={relative} onChange={event => setRelative(event.target.checked)}/>{t('相对时间')}</label></div>
    <div className="replay-trend-charts"><div className="chart-panel replay-trend-panel" data-replay-trend="ttft">
      <div className="replay-trend-panel-header"><h3>{t('首 Token 延迟')}</h3><span>ms · {t('平均值 · 回溯 {window}', { window: promDuration(config.windowSeconds) })}</span></div>
      {data.error && <div className="chart-error" role="status">{errorNote} · {localizeMessage(language, data.error)}</div>}
      <CacheTrend series={data.series} range={range} relativeOrigin={relative ? range.start : undefined} percent={false} unit="ms" decimals={1} language={language} label={t('首 Token 延迟')} emptyNote={emptyNote}/>
      <div className="replay-trend-note"><span>{t('按回放目标部署统计，可能包含其他业务流量')}</span>{data.observedAt !== undefined && <span>{t('观测于 {time}', { time: fullDateTime(data.observedAt) })}</span>}</div>
    </div></div>
    <p className="replay-latency-note">{t('首 Token 延迟沿用现有延迟指标口径，展示窗口平均值；缺失或非有限样本显示为断点。')}</p>
  </section>;
}
