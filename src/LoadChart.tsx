import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { LoadData, TimeRange } from './types';
import { formatValue, normalizeRange } from './data';
import { chartTime, formatRelativeTime, relativeTimeUnit } from './chartTime';
import { fullDateTime } from './time';
import { translate, type Language } from './i18n';

/**
 * 纯图表组件，不发起 HTTP 请求；两种窗口均接收 App 提供的 LoadData。
 * 数据来源和查询条件由 App/data.ts 负责，这里只做绘制、坐标转换和刷选回传。
 */
interface Props {
  language?: Language; // 只翻译标题和 tooltip，查询时间、模型和选区保持不变。
  data: LoadData; // matrix 适配结果。
  range: TimeRange; // 查询窗口，Unix 秒。
  selection?: TimeRange; // 父组件持有的选区，用于同步两条折线的阴影。
  onSelect?: (range: TimeRange | undefined) => void; // undefined 同步清除选区，不创建回放。
  selectable?: boolean; // 历史窗口开启；回放窗口只观测。
  relativeOrigin?: number; // 实际 started_at，用于显示经过时间，单位仍为秒。
  max?: number;
}
const colors = ['#6d78ec', '#10a78e', '#ba72d6', '#c39732'];
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
export default function LoadChart({ data, range, selection, onSelect, selectable, relativeOrigin, max, language = 'zh' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts>();
  const callback = useRef(onSelect);
  callback.current = onSelect;
  const bounds = useRef(range); bounds.current = range;
  useEffect(() => {
    const instance = echarts.init(ref.current!);
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize()); observer.observe(ref.current!);
    const handler = (event: any) => {
      if(event.areas?.length===0){callback.current?.(undefined);return;}
      const coords = event.areas?.[0]?.coordRange;
      if (!Array.isArray(coords) || coords.length !== 2) return;
      // 可刷选的历史图使用绝对时间轴：ECharts 毫秒 → API Unix 秒 → 排序/裁剪。
      // 再通过 onSelect 交给父组件，等待用户确认后才提交 POST。
      const selected = normalizeRange(Number(coords[0]) / 1000, Number(coords[1]) / 1000, bounds.current);
      if (selected.end > selected.start) callback.current?.(selected);
    };
    instance.on('brushEnd', handler);
    // 工具栏清除只发送 brush 事件；程序恢复选区的 brush 事件不触发回传。
    instance.on('brush',(event: any)=>{if(event.command==='clear')callback.current?.(undefined);});
    return () => { observer.disconnect(); instance.dispose(); chart.current = undefined; };
  }, []);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    // 绝对轴用毫秒；相对轴用经过秒数。转换集中在 chartTime，避免只换标签而保留日历刻度。
    const timeAxis = chartTime(range, relativeOrigin);
    const t=(text:string,values?:Record<string,string|number>)=>translate(language,text,values);
    const groups = [data.running, data.waiting];
    const series = groups.flatMap((group, grid) => group.map((s,i) => ({
      name: `${t(grid === 0 ? '正在处理' : '等待处理')} · ${s.name}`,
      type: 'line' as const,
      xAxisIndex: grid, yAxisIndex: grid,
      showSymbol: false, symbolSize: 5, connectNulls: false,
      lineStyle: { width: 2.2, color: grid === 0 ? colors[i % colors.length] : colors[(i + 1) % colors.length] },
      itemStyle: { color: grid === 0 ? colors[i % colors.length] : colors[(i + 1) % colors.length] },
      areaStyle: { opacity: .055 },
      // NaN/Inf 无法绘制为坐标，转为断点；data 中的原值保留，tooltip 仍能显示异常信号。
      data: s.points.map(p => [timeAxis.toAxis(p.timestamp), p.value !== undefined && Number.isFinite(p.value) ? p.value : null]),
      markArea: !selectable && selection ? { silent: true, itemStyle: { color: 'rgba(109,120,236,.09)' }, data: [[{ xAxis: timeAxis.toAxis(selection.start) }, { xAxis: timeAxis.toAxis(selection.end) }]] } : undefined
    })));
    instance.setOption({
      animation: false,
      textStyle: { fontFamily:'Inter, system-ui, sans-serif' },
      toolbox: selectable ? {feature:{brush:{type:['lineX','clear'],title:{lineX:t('横向选择'),clear:t('清除选择')}}}} : undefined,
      title: [
        { text:t('正在处理'), subtext:t('请求数 / requests'), left:10,top:8,textStyle:{fontSize:12,fontWeight:500,color:'#586279'},subtextStyle:{fontSize:10,color:'#96a0b1'} },
        { text:t('等待处理'), subtext:t('请求数 / requests'), left:10,top:224,textStyle:{fontSize:12,fontWeight:500,color:'#586279'},subtextStyle:{fontSize:10,color:'#96a0b1'} }
      ],
      // 两行日期/时间标签需要额外空间：两图之间留白，底部保留 52px，避免被回放区间遮挡。
      grid: [{left:46,right:18,top:56,height:116},{left:46,right:18,top:272,bottom:52}],
      xAxis: [0,1].map(gridIndex => ({type:timeAxis.type,gridIndex,min:timeAxis.min,max:timeAxis.max,minInterval:timeAxis.relative?1:undefined,splitNumber:ref.current!.clientWidth<500?3:5,axisLine:{lineStyle:{color:'#e5e9f0'}},axisTick:{show:false},axisLabel:{color:'#8b95a7',fontSize:10,lineHeight:14,margin:10,formatter:timeAxis.format,hideOverlap:true,showMinLabel:timeAxis.relative?true:undefined},axisPointer:{label:{formatter:(params:{value:number})=>timeAxis.format(params.value)}},splitLine:{show:false}})),
      yAxis: [0,1].map(gridIndex => ({type:'value',gridIndex,min:0,max,splitNumber:3,minInterval:1,axisLabel:{color:'#8b95a7',fontSize:10},splitLine:{lineStyle:{color:'#edf0f5',type:'dashed'}},axisLine:{show:false}})),
      axisPointer: { link:[{xAxisIndex:'all'}] },
      tooltip: {
        trigger:'axis', confine:true, backgroundColor:'#fff',borderColor:'#e5e9f0',textStyle:{color:'#243047',fontSize:12},
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params];
          if (!items.length) return '';
          const axisValue = Number(items[0].value[0]);
          // 绘图坐标还原到 Unix 秒，才能匹配原始采样点并按上海时间展示实际时刻。
          const timestamp = timeAxis.fromAxis(axisValue);
          const details = groups.flatMap((group,g) => group.map(s => {
            const p = s.points.find(p => p.timestamp === timestamp);
            const color = Number.isNaN(p?.value) ? '#d35163' : '#243047';
            return `<div style="margin-top:5px">${t(g===0?'正在处理':'等待处理')} · ${escape(s.name)} <b style="color:${color}">${formatValue(p?.value,0,language)}</b></div>`;
          })).join('');
          const elapsed = timeAxis.relative ? `<div>${t('回放 + {elapsed}（{unit}）',{elapsed:formatRelativeTime(axisValue,range.end-range.start),unit:relativeTimeUnit(range.end-range.start,language)})}</div>` : '';
          return `${elapsed}<div>${fullDateTime(timestamp)}</div>${details}`;
        }
      },
      brush: selectable ? { xAxisIndex:'all', brushType:'lineX',brushMode:'single',brushLink:'all',transformable:true,removeOnClick:false,throttleType:'debounce',throttleDelay:100,brushStyle:{color:'rgba(109,120,236,.13)',borderColor:'#8490ec',borderWidth:1} } : undefined,
      series
    }, true);
    if (selectable) {
      // 两个 grid 使用相同 Unix 毫秒边界；重新绘制时恢复父组件已保存的选区。
      instance.dispatchAction({type:'takeGlobalCursor',key:'brush',brushOption:{brushType:'lineX',brushMode:'single'}});
      instance.dispatchAction({type:'brush',areas:selection?[{brushType:'lineX',xAxisIndex:0,coordRange:[selection.start*1000,selection.end*1000]},{brushType:'lineX',xAxisIndex:1,coordRange:[selection.start*1000,selection.end*1000]}]:[]});
    }
  }, [data, range, selection, selectable, relativeOrigin, max, language]);
  return <div ref={ref} className="load-chart" role="img" aria-label={translate(language,'正在处理与等待处理请求曲线，可通过下方时间输入精确设置回放区间')} />;
}
