import type { TimeRange } from './types';
import { timeParts } from './time';
import { translate, type Language } from './i18n';

export function relativeTimeUnit(spanSeconds: number, language: Language = 'zh'): string {
  return translate(language, spanSeconds < 60 ? '秒' : spanSeconds < 3600 ? '分:秒' : '时:分:秒');
}

export function formatRelativeTime(seconds: number, spanSeconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const total = Math.round(Math.abs(seconds));
  if (spanSeconds < 60) return `${sign}${total} s`;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (spanSeconds < 3600) return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  return `${sign}${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/**
 * API/页面始终保存 Unix 秒；仅在进入 ECharts 时转换坐标。
 * 绝对轴：Unix 秒 × 1000 → time 轴；相对轴：Unix 秒 - started_at → value 轴。
 * fromAxis 用于 tooltip 还原原时刻，此转换不修改网络查询和回放参数。
 */
export function chartTime(range: TimeRange, origin?: number) {
  const relative = origin !== undefined && Number.isFinite(origin);
  const span = range.end - range.start;
  const toAxis = (timestamp: number) => relative ? timestamp - origin! : timestamp * 1000;
  const fromAxis = (value: number) => relative ? origin! + value : value / 1000;
  const format = (value: number) => {
    if (relative) return formatRelativeTime(value, span);
    const p = timeParts(value / 1000);
    // 秒级刻度保留秒以区分同一分钟内的位置；整分钟省略末尾 :00。
    const time = `${p.hour}:${p.minute}` + (p.second === '00' ? '' : `:${p.second}`);
    return span >= 86400 ? `${p.month}/${p.day}\n${time}` : time;
  };
  return { relative, type: relative ? 'value' as const : 'time' as const, min: toAxis(range.start), max: toAxis(range.end), toAxis, fromAxis, format };
}
