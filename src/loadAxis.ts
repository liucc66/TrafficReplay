import type { LoadData } from './types';

export interface LoadAxisMax { running: number; waiting: number }
export interface LoadAxisState {
  historyKey: string; replayKey: string;
  history: LoadData; replay: LoadData;
  historyReady: boolean; replayReady: boolean;
  max: LoadAxisMax;
}
const emptyMax = (): LoadAxisMax => ({ running: 10, waiting: 10 });

/** 同类历史/回放共用刻度；范围变化忽略尚未替换的旧数据。 */
export function updateLoadAxis(previous: LoadAxisState | undefined, historyKey: string, replayKey: string, history: LoadData, replay: LoadData): LoadAxisState {
  const historyChanged = !previous || previous.historyKey !== historyKey;
  const replayChanged = !previous || previous.replayKey !== replayKey;
  const historyReady = !previous || history !== previous.history || (!historyChanged && previous.historyReady);
  const replayReady = !previous || replay !== previous.replay || (!replayChanged && previous.replayReady);
  const max = historyChanged || replayChanged ? emptyMax() : { ...previous!.max };
  for (const key of ['running', 'waiting'] as const) {
    const series = [...(historyReady ? history[key] : []), ...(replayReady ? replay[key] : [])];
    for (const row of series) for (const point of row.points) {
      if (point.value !== undefined && Number.isFinite(point.value)) {
        max[key] = Math.max(max[key], Math.ceil(point.value * 1.15 / 10) * 10);
      }
    }
  }
  return { historyKey, replayKey, history, replay, historyReady, replayReady, max };
}
