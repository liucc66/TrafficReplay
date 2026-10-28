import { useEffect, useMemo, useRef, useState } from 'react';
import { Database, Gauge, Zap } from 'lucide-react';
import type { ApiConfig } from './apiConfig';
import CacheTrend from './CacheTrend';
import { formatValue, promDuration } from './data';
import { localizeMessage, translate, type Language } from './i18n';
import { isTerminalReplay } from './replay';
import { emptyCacheData, fetchReplayCache, replayCachePlan, retainReplayCache, type CacheMetricKey, type CachePlan, type ReplayCacheConfig } from './replayCacheData';
import { fullDateTime } from './time';
import type { Replay } from './types';

const cards = [
  { key: 'kv', title: 'KV Cache 使用率', icon: Database },
  { key: 'hitRate', title: '前缀缓存命中率', icon: Gauge },
  { key: 'hitTokens', title: '命中 token/s', icon: Zap },
] as const;

export default function ReplayCache({ replay, api, config, language, refreshToken, taskStatus }: {
  replay?: Replay; api: ApiConfig; config: ReplayCacheConfig; language: Language; refreshToken: number; taskStatus?: string;
}) {
  const t = (text: string, values?: Record<string, string | number>) => translate(language, text, values);
  const [data, setData] = useState(emptyCacheData), [plan, setPlan] = useState<CachePlan>();
  const [loading, setLoading] = useState(false), [settled, setSettled] = useState(false), [relative, setRelative] = useState(true);
  const [counterUnit, setCounterUnit] = useState(config.counterUnit);
  const observationConfig = useMemo(() => ({ ...config, counterUnit }), [config, counterUnit]);
  const taskRef = useRef(replay); taskRef.current = replay;
  const labels = JSON.stringify(Object.entries(replay?.metricsLabels || {}).sort(([a], [b]) => a.localeCompare(b)));
  const terminal = !!replay && isTerminalReplay(replay.status);
  useEffect(() => { setData(emptyCacheData()); setPlan(undefined); setSettled(false); setLoading(false); }, [replay?.id, replay?.startedAt, replay?.metricsName, labels, counterUnit]);
  useEffect(() => {
    if (!replay || replay.startedAt === undefined) return;
    let live = true, busy = false, done = false; setSettled(false);
    let startTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const load = async () => {
      const task = taskRef.current;
      if (!live || busy || done || document.hidden || task?.id !== replay.id) return;
      const requestedAt = Date.now() / 1000;
      const nextPlan = replayCachePlan(task, requestedAt, observationConfig);
      if (!nextPlan) {
        // started_at 可带小数；等到首个可查询整秒，不额外等待下一轮 30s 刷新。
        clearTimeout(startTimer);
        startTimer = globalThis.setTimeout(() => void load(), Math.max(1, Math.min(30000, Math.ceil(task.startedAt!) * 1000 - Date.now())));
        return;
      }
      clearTimeout(startTimer);
      busy = true; setLoading(true); setPlan(nextPlan);
      try {
        const next = await fetchReplayCache(task, nextPlan, observationConfig, api);
        if (!live) return;
        setData(previous => retainReplayCache(previous, next));
        if (nextPlan.settleAfter !== undefined && requestedAt >= nextPlan.settleAfter && Object.values(next).every(item => !item.current.error && !item.trend.error)) { done = true; setSettled(true); }
      } catch (error) {
        if (live) {
          const failed = emptyCacheData();
          for (const { key } of cards) { failed[key].current.error = (error as Error).message; failed[key].trend.error = (error as Error).message; }
          setData(previous => retainReplayCache(previous, failed));
        }
      } finally { busy = false; if (live) setLoading(false); }
    };
    void load();
    const timer = globalThis.setInterval(() => void load(), 30000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { live = false; clearTimeout(startTimer); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [replay?.id, replay?.startedAt, replay?.finishedAt, replay?.metricsName, labels, terminal, api, observationConfig, refreshToken]);

  const unitConfirmed = counterUnit !== 'unknown';
  const tokens = counterUnit === 'tokens';
  const baseNote = !replay ? '等待创建回放任务' : replay.startedAt === undefined ? terminal ? '任务已结束，未开始打流' : '等待实际打流开始时间' : '暂无样本 · 检查指标、标签与采集状态';
  const emptyNote = (key: CacheMetricKey) => t(key !== 'kv' && !unitConfirmed ? '请先确认缓存计数单位' : key === 'hitTokens' && !tokens ? '当前计数单位不是 token，无法换算 token/s' : key !== 'kv' && replay?.startedAt !== undefined && !plan?.rateRange ? terminal && settled ? '任务观测时段不足完整统计窗口' : '采集中 · 等待完整统计窗口' : baseNote);
  const errors = Object.values(data).some(item => item.current.error || item.trend.error);
  // 进度约 2s 更新一次；图表只随 30s 指标窗口变化重绘，保持 tooltip 稳定。
  // 查询从向上取整后的 Unix 秒开始，显示轴保留真实 started_at，令相对零点精确为 0。
  const range = useMemo(() => plan && replay?.startedAt !== undefined ? { start: replay.startedAt, end: Math.max(replay.startedAt + config.scrapeSeconds, plan.range.end) } : { start: 0, end: 60 }, [plan, replay?.startedAt, config.scrapeSeconds]);
  const labelsText = Object.entries({ ...config.labels, ...replay?.metricsLabels }).filter(([key]) => key !== 'model_name').map(([key, value]) => `${key}=${value}`).join(' · ');
  const rateNote = t('部署合计 · 回溯 {window}', { window: promDuration(config.windowSeconds) });
  const countNote = t(tokens ? '按 token 统计' : counterUnit === 'blocks' ? '按缓存块统计' : '按请求统计');
  return <section className="replay-cache-section" aria-label={t('回放缓存观测')}>
    <div className="section-title"><div><h2>{t('回放缓存观测')}</h2><span>REPLAY CACHE</span></div><span className="section-hint">{t('每 30s 更新')}</span></div>
    <div className="replay-latency-context"><span>{replay ? replay.metricsLabels?.model_name || replay.metricsName : t('等待创建回放任务')}</span>{replay && <><code>{replay.id}</code><span>{taskStatus}</span></>}
      <span role="status">{t(errors ? '部分指标查询失败，显示最近成功数据' : settled ? '最终观测已固定' : terminal && replay?.startedAt !== undefined ? '任务已结束，正在补采尾部指标' : loading ? '查询中…' : plan ? '持续观测中' : baseNote)}</span></div>
    {replay && <div className="replay-latency-source">{labelsText || t('仅按模型筛选，可能包含其他部署')}<br/>{t('来源历史：{start} — {end}', { start: fullDateTime(replay.source.start), end: fullDateTime(replay.source.end) })}</div>}
    <div className="cache-unit-settings"><label>{t('缓存计数单位')}<select aria-label={t('缓存计数单位')} value={counterUnit} onChange={event => setCounterUnit(event.target.value as ReplayCacheConfig['counterUnit'])}>
      <option value="unknown">{t('尚未确认')}</option><option value="tokens">{t('token 数')}</option><option value="blocks">{t('缓存块数')}</option><option value="requests">{t('请求数')}</option>
    </select></label><span>{t('按实际指标定义选择；hits 和 queries 必须使用相同单位，仅 token 计数可展示 token/s。')}</span></div>
    <div className="cache-cards">{cards.map(({ key, title, icon: Icon }) => {
      const current = data[key].current;
      const note = current.error ? t(current.value === undefined ? '查询失败 · 查看详情' : '查询失败 · 显示上次数据') : current.value === undefined ? emptyNote(key) : key === 'kv' ? t(terminal ? '回放期间实例峰值' : '当前实例最大值') : `${rateNote} · ${countNote}`;
      return <div className="metric-card" key={key} data-cache-metric={key}>
        <div className="metric-label">{t(title)}<Icon size={16}/></div>
        <div className="metric-value">{formatValue(current.value, key === 'hitTokens' ? 2 : 1, language)}<span>{key === 'hitTokens' ? 'token/s' : '%'}</span></div>
        <div className="cache-card-note">{note}</div>
        {key === 'kv' && current.value !== undefined && <div className="cache-instance" title={current.name}>{current.name}</div>}
        {current.observedAt !== undefined && <div className="metric-observed">{t('观测于 {time}', { time: fullDateTime(current.observedAt) })}</div>}
        {current.error && <details className="metric-error"><summary>{t('错误详情')}</summary><p>{localizeMessage(language, current.error)}</p></details>}
      </div>;
    })}</div>
    <div className="cache-charts">{cards.map(({ key, title }) => <div className={`chart-panel cache-panel cache-panel-${key}`} key={key} data-cache-chart={key}>
      <div className="cache-panel-header"><h3>{t(title)}{t('趋势')}</h3>{key === 'kv' ? <label className="relative"><input type="checkbox" checked={relative} onChange={e => setRelative(e.target.checked)}/>{t('相对时间')}</label> : <span>{rateNote}</span>}</div>
      {data[key].trend.error && <div className="chart-error" role="status">{t('查询失败 · 显示上次数据')} · {localizeMessage(language, data[key].trend.error!)}</div>}
      <CacheTrend series={data[key].trend.series} range={range} relativeOrigin={relative ? range.start : undefined} percent={key !== 'hitTokens'} language={language} label={t(title) + t('趋势')} emptyNote={emptyNote(key)}/>
      <div className="cache-chart-note">{key === 'kv' ? t('按实例分别展示，不相加') : `${rateNote} · ${unitConfirmed ? countNote : t('请先确认缓存计数单位')}`}{data[key].trend.observedAt !== undefined && <span>{t('观测于 {time}', { time: fullDateTime(data[key].trend.observedAt!) })}</span>}</div>
    </div>)}</div>
    <p className="replay-latency-note">{t('指标属于回放目标部署，可能包含其他业务流量；无请求或缺失指标显示空值，采集与缓存会带来延迟。')}</p>
  </section>;
}
