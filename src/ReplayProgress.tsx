import type { Replay } from './types';
import { formatValue } from './data';
import { clock } from './time';
import { isTerminalReplay, replayPercent } from './replay';
import { localizeMessage, translate, type Language } from './i18n';

export default function ReplayProgress({ replay, language }: { replay: Replay; language: Language }) {
  const t = (text: string, values?: Record<string, string | number>) => translate(language, text, values);
  const total = replay.requestCount;
  const percent = replayPercent(replay);
  const pending = total === undefined;
  const hint = replay.statusError ? t('状态更新暂时失败，显示上次收到的数据')
    : pending ? t(isTerminalReplay(replay.status) ? '任务已结束，总请求数尚未确定' : '正在检索请求档案，统计总请求数')
    : total === 0 ? t('此选区没有可回放请求')
    : replay.status === 'draining' ? t('请求已全部发送，等待在途响应结束')
    : replay.status === 'cancelling' ? t('正在取消，等待已提交请求处理结束')
    : replay.status === 'cancelled' ? t('任务已停止，保留实际进度') : '';

  return <div className="replay-progress" data-status={replay.status} aria-label={t('回放任务进度')}>
    <div className="replay-progress-heading">
      <div><span>{t('已完成 / 总请求')}</span><strong className="replay-progress-count">{pending ? t('统计中…') : `${formatValue(replay.completedCount,0,language)} / ${formatValue(total,0,language)}`}</strong></div>
      <span className="replay-progress-percent">{percent === undefined ? '—' : `${formatValue(percent,1,language)}%`}</span>
    </div>
    <div className={`replay-progress-track ${pending && !isTerminalReplay(replay.status) ? 'indeterminate' : ''}`} role="progressbar" aria-label={t('已完成 / 总请求')}
      aria-valuemin={0} aria-valuemax={percent === undefined ? undefined : total}
      aria-valuenow={percent === undefined ? undefined : Math.min(replay.completedCount!,total!)}
      aria-valuetext={pending ? t('总请求数尚未确定') : t('已完成 {completed} / {total} 个请求',{completed:formatValue(replay.completedCount,0,language),total:formatValue(total,0,language)})}>
      <div className="replay-progress-fill" style={{width:`${percent ?? (pending&&!isTerminalReplay(replay.status)?30:0)}%`}} />
    </div>
    <div className="replay-progress-details">
      <div><span>{pending ? t('总请求数尚未确定') : t('已发送 {sent} / {total}',{sent:formatValue(replay.sentCount,0,language),total:formatValue(total,0,language)})}</span>
        {!!replay.failedCount && <span className="replay-progress-failed">{t('失败 {count} 个',{count:formatValue(replay.failedCount,0,language)})}</span>}
        {!!replay.skippedCount && <span>{t('跳过 {count} 个',{count:formatValue(replay.skippedCount,0,language)})}</span>}</div>
      <span>{replay.statusUpdatedAt !== undefined ? t(replay.statusError ? '上次更新于 {time}' : '数据更新于 {time}',{time:clock(replay.statusUpdatedAt)}) : t('等待状态更新')}</span>
    </div>
    {hint && <p className="replay-progress-hint" role="status">{hint}</p>}
    {replay.taskError && <p className="replay-progress-error" role="alert">{t('任务失败：')}{replay.taskError}</p>}
    {replay.statusError && <details className="replay-progress-error"><summary>{t('错误详情')}</summary><p>{localizeMessage(language,replay.statusError)}</p></details>}
  </div>;
}
