import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiConfig } from './apiConfig';
import CacheTrend from './CacheTrend';
import { promDuration } from './data';
import { localizeMessage, translate, type Language } from './i18n';
import { isTerminalReplay } from './replay';
import { replayTrendCanSettle, replayTrendHasInsufficientWindow, replayTrendPlan, type ReplayTrendPlan } from './replayTrendData';
import { applyThroughputResult, emptyThroughputData, fetchThroughput, throughputTarget, type ReplayThroughputConfig, type ThroughputData, type TokenDirection } from './replayThroughputData';
import { fullDateTime } from './time';
import type { Replay } from './types';

const names = { input: '输入 Token', output: '输出 Token', total: '总 Token' };
const directions = ['input', 'output'] as const;

export default function ReplayThroughput({ replay, api, config, language, refreshToken }: {
  replay?: Replay; api: ApiConfig; config: ReplayThroughputConfig; language: Language; refreshToken: number;
}) {
  const t = (text: string, values?: Record<string, string | number>) => translate(language, text, values);
  const [data, setData] = useState<ThroughputData>(emptyThroughputData);
  const [plan, setPlan] = useState<ReplayTrendPlan>();
  const [loading, setLoading] = useState(false), [settled, setSettled] = useState(false), [relative, setRelative] = useState(true);
  const currentTask = useRef(replay); currentTask.current = replay;
  const batchId = useRef(0);
  const target = replay ? throughputTarget(replay, config) : undefined;
  const targetKey = JSON.stringify(target);
  const terminal = !!replay && isTerminalReplay(replay.status);
  const insufficient = !!replay && replayTrendHasInsufficientWindow(replay, config, config.tailSeconds);
  const configured = !!target;

  useEffect(() => { setData(emptyThroughputData()); setPlan(undefined); setSettled(false); setLoading(false); }, [replay?.id, replay?.modelId, replay?.startedAt, targetKey]);
  useEffect(() => {
    setSettled(false); setLoading(false);
    if (!replay || replay.startedAt === undefined || !configured || insufficient) return;
    let live = true, busy = false, done = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const task = currentTask.current;
      if (!live || busy || done || document.hidden || task?.id !== replay.id) return;
      const batchStartedAt = Date.now(), requestedAt = batchStartedAt / 1000;
      const nextPlan = replayTrendPlan(task, requestedAt, config, config.tailSeconds);
      if (!nextPlan) {
        clearTimeout(startTimer);
        startTimer = setTimeout(() => void load(), Math.max(1, Math.min(30000, Math.ceil(task.startedAt! + config.windowSeconds) * 1000 - Date.now())));
        return;
      }
      clearTimeout(startTimer);
      busy = true; setLoading(true); setPlan(nextPlan);
      const batch = ++batchId.current;
      setData(previous => ({ ...previous, total: { ...previous.total, error: '总吞吐等待同轮输入与输出数据' } }));
      // 每个响应到达即可独立展示；另一条慢查询不阻塞已成功的曲线或回放进度。
      const results = await Promise.all(directions.map(async (direction: TokenDirection) => {
        try {
          const result = await fetchThroughput(target!, direction, nextPlan, config, api, batchStartedAt);
          if (live) setData(previous => applyThroughputResult(previous, direction, result, batch));
          return true;
        } catch (error) {
          if (live) setData(previous => applyThroughputResult(previous, direction, { points: [], error: (error as Error).message }, batch));
          return false;
        }
      }));
      busy = false;
      if (!live) return;
      setLoading(false);
      if (results.every(Boolean) && replayTrendCanSettle(nextPlan, requestedAt)) { done = true; setSettled(true); }
    };
    void load();
    const timer = setInterval(() => void load(), 30000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { live = false; clearTimeout(startTimer); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [replay?.id, replay?.modelId, replay?.startedAt, replay?.finishedAt, terminal, targetKey, configured, insufficient, api, config, refreshToken]);

  const range = useMemo(() => replay?.startedAt !== undefined
    ? { start: replay.startedAt, end: Math.max(replay.startedAt + config.scrapeSeconds, plan?.range.end ?? replay.startedAt + config.windowSeconds) }
    : { start: 0, end: 60 }, [replay?.startedAt, plan, config]);
  const baseNote = !replay ? '等待创建回放任务' : !configured ? '未配置 LiteLLM 目标映射，请配置 targets'
    : replay.startedAt === undefined ? terminal ? '任务已结束，未开始打流' : '等待实际打流开始时间'
    : insufficient ? '任务观测时段不足完整统计窗口' : !plan ? '采集中 · 等待完整统计窗口' : '暂无样本 · 检查指标、标签与采集状态';
  const hasError = directions.some(key => data[key].error);
  const hasSamples = directions.some(key => data[key].points.some(point => Number.isFinite(point.value)));
  const series = (['input', 'output', 'total'] as const).filter(key => data[key].points.length).map(key => ({ id: key, name: t(names[key]), points: data[key].points }));
  const status = hasError ? directions.some(key => data[key].observedAt !== undefined) ? '查询失败 · 显示最近成功数据' : '查询失败 · 查看详情' : settled ? '最终观测已固定' : !configured || insufficient || !plan ? baseNote
    : terminal ? '任务已结束，正在补采尾部指标' : loading ? '查询中…' : hasSamples ? '持续观测中' : baseNote;

  return <section className="replay-throughput-section" aria-label={t('Token 吞吐率趋势')}>
    <div className="section-title"><div><h2>{t('Token 吞吐率趋势')}</h2><span>TOKEN THROUGHPUT</span></div><span className="section-hint">{t('统计窗口 {window} · 每 30s 更新', { window: promDuration(config.windowSeconds) })}</span></div>
    <div className="replay-trend-context"><span>{target ? `requested_model=${target.requestedModel}` : replay?.modelId || t('等待创建回放任务')}</span>{replay && <code title={replay.id}>{replay.id}</code>}<span role="status">{t(status)}</span></div>
    {replay && <div className="replay-latency-source">{target && Object.entries(target.labels).map(([key, value]) => `${key}=${value}`).join(' · ') || t('仅按模型筛选，可能包含其他部署')}<br/>{t('LiteLLM 记账窗口吞吐，可能包含其他业务流量')}</div>}
    {!configured && replay && <p className="replay-latency-note">{t('配置 VITE_REPLAY_THROUGHPUT_CONFIG.targets，将回放目标 target_model 映射为 requested_model；指标来自 LiteLLM，不自动回退到 vLLM。')}</p>}
    <div className="replay-trend-toolbar"><span>{t('曲线以实际打流时间为起点')}</span><label className="relative"><input type="checkbox" checked={relative} onChange={event => setRelative(event.target.checked)}/>{t('相对时间')}</label></div>
    <div className="chart-panel replay-trend-panel" data-replay-trend="throughput">
      <div className="replay-trend-panel-header"><h3>{t('输入 / 输出 / 总 Token')}</h3><span>token/s · {t('回溯 {window}', { window: promDuration(config.windowSeconds) })}</span></div>
      {directions.map(key => data[key].error && <div key={key} className="chart-error" role="status">{t(names[key])} · {t(data[key].observedAt === undefined ? '查询失败 · 查看详情' : '查询失败 · 显示最近成功数据')} · {localizeMessage(language, data[key].error!)}</div>)}
      {data.total.error && <div className="replay-latency-source" role="status">{t(data.total.error)}{data.total.observedAt !== undefined && ` · ${t('显示最近成功数据')}`}</div>}
      <CacheTrend series={series} range={range} relativeOrigin={relative ? range.start : undefined} percent={false} unit="token/s" language={language} label={t('Token 吞吐率趋势')} emptyNote={loading ? t('查询中…') : t(baseNote)} interactiveLegend/>
      <div className="replay-trend-note">{(['input', 'output', 'total'] as const).map(key => data[key].observedAt !== undefined && <span key={key}>{t(names[key])} · {t('观测于 {time}', { time: fullDateTime(data[key].observedAt!) })}</span>)}</div>
    </div>
    <p className="replay-latency-note">{t('先 rate 后求和；缺失或非有限值显示为断点。总吞吐仅合并同轮有效样本；这是记账速率，非逐 Token 解码速度。')}</p>
  </section>;
}
