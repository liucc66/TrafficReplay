import { updateLoadAxis, type LoadAxisState } from './loadAxis';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Check, Languages, Layers3, LoaderCircle, Play, Radio, RefreshCw, Search, Settings2, Target, Trash2, X } from 'lucide-react';
import LoadChart from './LoadChart';
import ReplayProgress from './ReplayProgress';
import LatencyCard, { LATENCY_CARDS } from './LatencyCard';
import ReplayLatency from './ReplayLatency';
import ReplayTrend from './ReplayTrend';
import ReplayThroughput from './ReplayThroughput';
import { createReplayThroughputConfig } from './replayThroughputData';
import ReplayCache from './ReplayCache';
import { createReplayCacheConfig } from './replayCacheData';
import { createReplayLatencyConfig, replayLoadWindow } from './replayLatencyData';
import { isTerminalReplay } from './replay';
import { readSnapshot, saveSnapshot } from './replayStorage';
import { useReplay } from './useReplay';
import { relativeTimeUnit } from './chartTime';
import { DISPLAY_TIME_ZONE, clock, dateTime, fullDateTime, toInput, fromInput } from './time';
import { emptyMetrics, fetchModels, fetchTargetModels, fetchLoad, fetchMetrics, formatValue, MODEL_DISCOVERY_QUERY, promDuration, queryTiming, retainFailedLoad, setMetricsAuth } from './data';
import type { LoadData, Metrics, Model, Replay, ReplaySpeed, TimeRange } from './types';
import { createMetricsApiConfigs } from './apiConfig';
import { localizeMessage, readLanguage, rememberLanguage, translate, type Language } from './i18n';
/**
 * 页面编排层：负责选择条件、网络查询、回放任务和组件数据之间的流转。
 * 历史：Prometheus 模型标签 → 当前模型/时间范围 → fetchLoad → history → 左侧 LoadChart。
 * 回放：selection → POST → replay_id → GET 状态 → 实际时间/标签
 *      → fetchLoad → replayData → 右侧 LoadChart。
 * 完整请求的检索和重新发送在后端执行；本页只提交回放条件并观测指标。
 */
const EMPTY: LoadData = { running:[],waiting:[],errors:[] };
const { history: API, replay: REPLAY_API, throughput: THROUGHPUT_API } = createMetricsApiConfigs(import.meta.env);
const REPLAY_LATENCY = createReplayLatencyConfig(import.meta.env);
const REPLAY_CACHE = createReplayCacheConfig(import.meta.env, REPLAY_LATENCY.scrapeSeconds);
const REPLAY_THROUGHPUT = createReplayThroughputConfig(import.meta.env, REPLAY_LATENCY.scrapeSeconds);
// 路径由构建时环境配置覆盖；回放接口为待与真实后端联调的契约。
const CREATE = import.meta.env.VITE_REPLAY_CREATE_PATH || '/api/replays';
const STATUS = import.meta.env.VITE_REPLAY_STATUS_PATH || '/api/replays/{id}';
const ACTIVE = import.meta.env.VITE_REPLAY_ACTIVE_PATH || '/api/replays/active';
const CANCEL = import.meta.env.VITE_REPLAY_CANCEL_PATH || '/api/replays/{id}/cancel';
const PATHS = {create:CREATE,status:STATUS,active:ACTIVE,cancel:CANCEL};
const STORAGE_SCOPE = import.meta.env.VITE_REPLAY_STORAGE_SCOPE || `${CREATE}|${STATUS}|${ACTIVE}|${CANCEL}`;
const PROXY_AUTH = import.meta.env.VITE_REPLAY_AUTH_MODE === 'proxy';
const statusNames: Record<Replay['status'],string> = {queued:'等待开始',preparing:'准备请求',running:'回放中',draining:'等待处理完成',cancelling:'正在取消',succeeded:'已完成',failed:'失败',cancelled:'已取消'};


export default function App() {
  const [saved]=useState(()=>readSnapshot(STORAGE_SCOPE));
  const [language,setLanguage]=useState<Language>(readLanguage);
  const t=(text:string,values?:Record<string,string|number>)=>translate(language,text,values);
  const message=(text:string)=>localizeMessage(language,text);
  // 切换语言仅触发文案/图表重绘，不重建指标查询或回放轮询。
  useEffect(()=>{
    rememberLanguage(language);
    document.documentElement.lang=language==='zh'?'zh-CN':'en';
    document.title=translate(language,'TrafficReplay / 大模型流量回放');
  },[language]);
  const [models,setModels]=useState<Model[]>([]);
  const [modelMode,setModelMode]=useState<'backend'>();
  const [modelsLoading,setModelsLoading]=useState(false);
  const [modelsToken,setModelsToken]=useState(0);
  const [modelId,setModelId]=useState(saved.history?.modelId || '');
  const [targetModelId,setTargetModelId]=useState(saved.history?.targetModelId || '');
  const [targetModels,setTargetModels]=useState<string[]>([]);
  const [targetModelsLoading,setTargetModelsLoading]=useState(false);
  const [targetModelsError,setTargetModelsError]=useState('');
  const [targetPickerOpen,setTargetPickerOpen]=useState(false);
  const [targetQuery,setTargetQuery]=useState('');
  const targetRequest=useRef(0);
  const modelIdRef=useRef(modelId);modelIdRef.current=modelId;
  const model=models.find(m=>m.id===modelId);
  // range 是历史查询窗口；selection 是其中准备回放的子区间，两者都使用 Unix 秒。
  const [seconds,setSeconds]=useState(saved.history?.seconds || 1800);
  const [historyEnd,setHistoryEnd]=useState<number | undefined>(saved.history?.historyEnd);
  const [range,setRange]=useState<TimeRange>(()=>saved.history?.range || (()=>{const t=queryTiming(1800);return {start:t.start,end:t.end};})());
  const [selection,setSelection]=useState<TimeRange | undefined>(saved.history?.selection);
  const [history,setHistory]=useState<LoadData>(EMPTY); // matrix 解析结果，仅供历史窗口。
  const [metrics,setMetrics]=useState<Metrics>(emptyMetrics);
  const [loading,setLoading]=useState(false);
  const [metricsLoading,setMetricsLoading]=useState(false); // 卡片独立加载状态，历史慢查询不影响空样本提示。
  const [refreshToken,setRefreshToken]=useState(0);
  const [updatedAt,setUpdatedAt]=useState<number>();
  const [error,setError]=useState('');
  // 任务保存创建时的模型和选区，独立于当前下拉框；右侧数据使用任务自身的查询上下文。
  const [replayData,setReplayData]=useState<LoadData>(EMPTY);
  const [replayRange,setReplayRange]=useState<TimeRange>();
  const [confirmOpen,setConfirmOpen]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [apiKey,setApiKey]=useState(''); // 仅内存保存，由调用方显式传给模型/回放接口。
  const [authHeader,setAuthHeader]=useState<'x-litellm-key'|'x-api-key'|'Authorization'>('Authorization');
  const [authSettings,setAuthSettings]=useState({apiKey:'',authHeader:'Authorization' as 'x-litellm-key'|'x-api-key'|'Authorization'});
  const [settingsToken,setSettingsToken]=useState(0);
  const [metricsKey,setMetricsKey]=useState('');
  const [metricsHeader,setMetricsHeader]=useState<'x-api-key'|'Authorization'>('x-api-key');
  const [metricsIdentity,setMetricsIdentity]=useState(0);
  const appliedMetrics=useRef({apiKey:'',authHeader:'x-api-key'});
  const [relative,setRelative]=useState(saved.history?.relative || false); // 只控制横轴展示，不改变查询边界或打流速度。
  const [speed,setSpeed]=useState<ReplaySpeed>(1);
  const replayController=useReplay({auth:authSettings,authReady:PROXY_AUTH || !!authSettings.apiKey.trim(),scope:STORAGE_SCOPE,paths:PATHS,metricsMap:REPLAY_API.modelMetricsMap});
  const {replay,replayRef,submitting,ready,restoring,recoveryError,actionError,pending,cancelling,clearing,clearNotice,clearDisabledReason,restoredId}=replayController;
  // 定时查询读取最新选区，避免每次拖动都重建查询 effect 或立即发起 HTTP 请求。
  const selectionRef=useRef(selection); selectionRef.current=selection;
  const active=!!replay&&!isTerminalReplay(replay.status);
  const targetModel=!targetModelsLoading&&!targetModelsError&&targetModels.includes(targetModelId)?targetModelId:'';
  const targetDisplay=active?replay!.modelId:targetModelId;
  const filteredTargets=targetModels.filter(name=>name.toLocaleLowerCase().includes(targetQuery.trim().toLocaleLowerCase()));
  const replayLabelsKey=JSON.stringify(Object.entries(replay?.metricsLabels || {}).sort(([a],[b])=>a.localeCompare(b)));
  const validSelection=!!selection&&selection.start>=range.start&&selection.end<=range.end&&selection.end>selection.start;
  const canCreate=ready && !restoring && !pending && !active && !submitting && !clearing;
  useEffect(()=>{
    saveSnapshot(STORAGE_SCOPE,{replay,history:{modelId,seconds,range,selection,historyEnd,relative,targetModelId}});
  },[replay,modelId,seconds,range,selection,historyEnd,relative,targetModelId]);
  // 模型入口：一次即时 query 从 vLLM gauge 的 model_name 标签生成下拉项，无需 LiteLLM 认证。
  // live 用于忽略切换数据源/卸载后到达的旧响应，不是网络请求取消器。
  useEffect(()=>{
    let live=true;
    setModelsLoading(true);
    fetchModels(API).then(list=>{
      if(!live)return;
      const previous=modelIdRef.current;
      const next=list.some(item=>item.id===previous)?previous:list[0]?.id||'';
      if(next!==previous){selectionRef.current=undefined;setSelection(undefined);setHistory(EMPTY);setMetrics(emptyMetrics);}
      setModels(previous=>list.map(item=>({...item,replayModelId:item.replayModelId||previous.find(model=>model.id===item.id)?.replayModelId})));setModelId(next);setModelMode('backend');
      if(!list.length)throw new Error('Prometheus 未返回 vLLM 模型，请检查采集目标和 vllm:num_requests_running 的 model_name 标签');
      setError('');
    }).catch(e=>{if(live)setError(`模型加载失败：${e.message}`);}).finally(()=>{if(live)setModelsLoading(false);});
    return()=>{live=false;};
  },[settingsToken,modelsToken]);
  const historyRestored=useRef<string>();
  useEffect(()=>{
    if(modelMode!=='backend'||!replay||restoredId!==replay.id||historyRestored.current===replay.id)return;
    historyRestored.current=replay.id;
    const sourceId=replay.sourceModelId || replay.modelId;
    // 同名逻辑模型在正式和灰度可有不同指标标签，历史不能借用目标标签。
    // 仅原单源、共享映射且来源=目标的旧任务保留标签恢复兼容。
    const legacySameSource=API.prometheusPrefix===REPLAY_API.prometheusPrefix && API.modelMetricsMap===REPLAY_API.modelMetricsMap && sourceId===replay.modelId;
    const metricsName=replay.sourceMetricsName || API.modelMetricsMap[sourceId] || (legacySameSource?replay.metricsLabels?.model_name||replay.metricsName:sourceId);
    const snapshot=readSnapshot(STORAGE_SCOPE).history;
    const cached=snapshot?.modelId===metricsName && snapshot.range.start<=replay.source.start && snapshot.range.end>=replay.source.end ? snapshot : undefined;
    const duration=cached?.seconds || Math.max(30,replay.source.end-replay.source.start);
    const window=cached?.range || {start:replay.source.start,end:replay.source.end};
    setModels(previous=>previous.some(item=>item.id===metricsName)
      ? previous.map(item=>item.id===metricsName?{...item,replayModelId:item.replayModelId||sourceId}:item)
      : [...previous,{id:metricsName,name:metricsName,metricsName,replayModelId:sourceId}]);
    selectionRef.current=replay.source;setSelection({...replay.source});setModelId(metricsName);setRange(window);setSeconds(duration);setHistoryEnd(cached?.historyEnd ?? window.end);setRefreshToken(value=>value+1);
  },[modelMode,restoredId,replay?.id]);
  // 查询左侧历史曲线和底部即时延迟卡片；成功结果分别进入 history / metrics。
  useEffect(()=>{
    if(!model||modelMode!=='backend')return;
    let live=true;let timer:number|undefined;let busy=false;
    const load=async()=>{
      if(busy||document.hidden)return;
      busy=true;setLoading(true);setMetricsLoading(true);setError('');
      let next=range;
      // 无选区时按截止时间计算窗口；有选区时保留原窗口，避免自动刷新移动已选边界。
      if(!selectionRef.current){const t=queryTiming(seconds,historyEnd);next={start:t.start,end:t.end};setRange(next);}
      try {
        const metricsName=model.metricsName||model.name;
        // 两条历史 gauge 与五条即时延迟 query 并发，历史接口较慢不阻塞卡片。
        // live 阻止切换模型/时间范围后的旧响应覆盖新模型数据。
        const results=await Promise.allSettled([
          (async()=>{
            const data=await fetchLoad(metricsName,next,undefined,API);
            if(live){setHistory(data);setUpdatedAt(Math.floor(Date.now()/1000));}
          })(),
          (async()=>{
            // 即时 query 的评估时刻为现在；历史范围只决定 rate 回溯长度。
            try{
              const data=await fetchMetrics(metricsName,seconds,API);
              if(live)setMetrics(data);
            }finally{if(live)setMetricsLoading(false);}
          })()
        ]);
        if(live){const failed=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed.length)setError(failed.map(r=>r.reason.message).join('；'));}
      }catch(e){if(live)setError((e as Error).message);}finally{busy=false;if(live)setLoading(false);}
    };
    // 仅“截止到现在”的窗口定时更新；指定历史截止时间后通过手动刷新重新查询。
    void load();if(historyEnd===undefined)timer=window.setInterval(()=>void load(),30000);
    const visible=()=>{if(!document.hidden)void load();};document.addEventListener('visibilitychange',visible);
    return()=>{live=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  // 选区固定历史窗口，不将 range 放入依赖引起重复请求。
  },[modelMode,modelId,seconds,historyEnd,refreshToken]);
  // 曲线使用实际时间与目标标签，独立保持 30s 刷新及结束后的采集余量。
  useEffect(()=>{setReplayRange(undefined);setReplayData(EMPTY);},[replay?.id,replay?.startedAt,replay?.metricsName,replayLabelsKey]);
  useEffect(()=>{
    if(!replay||replay.startedAt===undefined)return;
    const id=replay.id;let live=true,busy=false,metricsSettled=false;
    const load=async()=>{
      const current=replayRef.current;
      if(!live||busy||document.hidden||metricsSettled||current?.id!==id||current.startedAt===undefined)return;
      busy=true;
      try{
        const requestedAt=Date.now()/1000;
        const plan=replayLoadWindow(current,requestedAt,REPLAY_LATENCY)!;
        const window=plan.range;
        // 与历史图共用解析，但指标源、标签和实际时间独立于历史查询。
        const data=await fetchLoad(current.metricsName,window,current.metricsLabels,REPLAY_API,{freshAfter:plan.settleAfter!==undefined&&requestedAt>=plan.settleAfter?plan.settleAfter*1000:undefined});
        if(live&&replayRef.current?.id===id){setReplayRange(window);setReplayData(previous=>retainFailedLoad(previous,data));}
        // 后端报告完成后再等待采集/缓存延迟，并在一次无查询错误的结果后停止轮询。
        // 这是前端刷新停止条件，不证明档案完整，也不是通过折线推断任务成功。
        if(plan.settleAfter!==undefined && requestedAt>=plan.settleAfter && data.errors.length===0)metricsSettled=true;
      }catch(e){if(live&&replayRef.current?.id===id)setReplayData(data=>({...data,errors:[(e as Error).message]}));}finally{busy=false;}
    };
    const visible=()=>{if(!document.hidden)void load();};
    void load();const timer=setInterval(()=>void load(),30000);
    document.addEventListener('visibilitychange',visible);
    return()=>{live=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[replay?.id,replay?.startedAt,replay?.finishedAt,replay?.metricsName,replayLabelsKey,refreshToken]);
  // 新模型需要重新选历史区间，但已创建的 replay 和 replayData 不清空。
  const chooseModel=(id:string)=>{setModelId(id);setSelection(undefined);setHistory(EMPTY);setMetrics(emptyMetrics);};
  const refreshTargets=async()=>{
    const token=++targetRequest.current;
    setTargetModelsLoading(true);setTargetModelsError('');
    try{
      const list=await fetchTargetModels();
      if(token!==targetRequest.current)return;
      setTargetModels(list);
      setTargetModelId(previous=>list.includes(previous)?previous:'');
    }catch(e){if(token===targetRequest.current)setTargetModelsError((e as Error).message);}
    finally{if(token===targetRequest.current)setTargetModelsLoading(false);}
  };
  const openTargetPicker=()=>{setTargetQuery('');setTargetPickerOpen(true);void refreshTargets();};
  const chooseTime=(duration:number)=>{setSeconds(duration);setSelection(undefined);setMetrics(emptyMetrics);};
  // 图表刷选只更新本地状态；真正 POST 要等用户在确认框中点击“开始回放”。
  const select=useCallback((s:TimeRange | undefined)=>{selectionRef.current=s;setSelection(s);},[]);
  const beginReplay=async()=>{
    if(!model||!targetModel||!selection||!validSelection||!canCreate)return;
    const sourceModel=model.replayModelId||model.id;
    const body={source_model:sourceModel,target_model:targetModel,start_time:selection.start,end_time:selection.end,speed};
    const targetMetricsName=REPLAY_API.modelMetricsMap[targetModel]||targetModel;
    const context:Replay={id:'',modelId:targetModel,sourceModelId:sourceModel,sourceModelName:model.name,sourceMetricsName:model.metricsName||model.name,modelName:targetModel,metricsName:targetMetricsName,source:{...selection},status:'queued',speed};
    await replayController.begin(body,context);
  };
  useEffect(()=>{if(replay&&!submitting&&!actionError)setConfirmOpen(false);},[replay?.id,submitting,actionError]);
  const changeInput=(key:'start'|'end',value:string)=>{
    // 上海本地时间文本 → Unix 秒；结果与图表拖拽一样流入 selection。
    const timestamp=fromInput(value);if(!Number.isFinite(timestamp))return;
    setSelection(s=>({...s??{start:range.start,end:range.end},[key]:timestamp}));
  };
  // 同类指标左右共用上限，同一观测期间只扩大；切换上下文后重算。
  const historyAxisKey=JSON.stringify([modelId,seconds,historyEnd]);
  const replayAxisKey=replay?.id || '';
  const [axisState,setAxisState]=useState<LoadAxisState>(()=>updateLoadAxis(undefined,historyAxisKey,replayAxisKey,history,replayData));
  let currentAxis=axisState;
  if(axisState.historyKey!==historyAxisKey||axisState.replayKey!==replayAxisKey||axisState.history!==history||axisState.replay!==replayData){
    currentAxis=updateLoadAxis(axisState,historyAxisKey,replayAxisKey,history,replayData);
    setAxisState(currentAxis);
  }
  const sharedMax=currentAxis.max;
  return <div className="app-shell">
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">Workspace</div><div className="header-right"><button className="language-switch" type="button" aria-label={language==='zh'?'Switch to English':'切换到中文'} title={language==='zh'?'Switch to English':'切换到中文'} onClick={()=>setLanguage(previous=>previous==='zh'?'en':'zh')}><Languages size={15}/><span lang="zh-CN" className={language==='zh'?'current':''}>中文</span><span className="language-divider">/</span><span lang="en" className={language==='en'?'current':''}>EN</span></button><button className="icon-button" aria-label={t('连接设置')} onClick={()=>setSettingsOpen(true)}><Settings2 size={18}/></button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">LLM TRAFFIC REPLAY</div><h1>TrafficReplay</h1><p>{t('回放历史请求，观察模型负载与排队变化，验证优化效果。')}</p></div><div className="heading-actions"><span className="refresh-note"><Radio size={13}/> {t('每 30s 更新')}</span><button className="button secondary" disabled={loading} onClick={()=>setRefreshToken(x=>x+1)}><RefreshCw size={14} className={loading?'spin':''}/>{t('刷新指标')}</button></div></div>
        <section className="filters" aria-label={t('查询设置')}>
          <div className="field model-field"><label htmlFor="model">{t('查询模型')} <button className="text-action" disabled={modelsLoading} onClick={()=>setModelsToken(token=>token+1)} aria-label={t('刷新模型列表')}>{t(modelsLoading?'加载中…':'刷新列表')}</button></label><div className="select-wrap"><Layers3 size={16}/><select id="model" value={modelId} onChange={e=>chooseModel(e.target.value)} disabled={!models.length}>{!models.length&&<option value="">{t('等待模型配置')}</option>}{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></div></div>
          <div className="field"><label htmlFor="range">{t('历史查询范围')}</label><select id="range" value={seconds} onChange={e=>chooseTime(Number(e.target.value))}>{![900,1800,3600,21600,43200,86400,604800].includes(seconds)&&<option value={seconds}>{t('任务历史区间')}</option>}<option value={900}>{t('最近 15 分钟')}</option><option value={1800}>{t('最近 30 分钟')}</option><option value={3600}>{t('最近 1 小时')}</option><option value={21600}>{t('最近 6 小时')}</option><option value={43200}>{t('最近 12 小时')}</option><option value={86400}>{t('最近 24 小时')}</option><option value={604800}>{t('最近 7 天')}</option></select></div>
          <div className="field history-end"><label htmlFor="history-end">{t('截止时间')} <button className="text-action" onClick={()=>{setHistoryEnd(undefined);setSelection(undefined);}}>{t('现在')}</button></label><input id="history-end" type="datetime-local" step="1" value={toInput(historyEnd??range.end)} onChange={e=>{const end=fromInput(e.target.value);if(Number.isFinite(end)){setHistoryEnd(end);setSelection(undefined);}}}/></div>
          <div className="filter-meta"><span className="model-tag">{model?.provider||'MODEL'}</span><span>{selection?t('历史窗口已固定'):t('约 60 个采样点 · {step}s 步长',{step:queryTiming(seconds).step})}</span></div>
        </section>
        {error&&<div className="error-banner" role="alert">{message(error)}<button aria-label={t('关闭错误')} onClick={()=>setError('')}><X size={15}/></button></div>}
        {(restoring||recoveryError)&&<div className="recovery-banner" role="status"><span>{restoring?t('正在恢复回放任务…'):message(recoveryError)}</span>{!restoring&&<button className="button secondary" disabled={clearing} onClick={()=>authSettings.apiKey||PROXY_AUTH?replayController.recover():setSettingsOpen(true)}>{t(authSettings.apiKey||PROXY_AUTH?'重试恢复':'填写认证')}</button>}</div>}
        {actionError&&<div className="error-banner" role="alert">{message(actionError)}<button aria-label={t('关闭错误')} onClick={replayController.clearActionError}><X size={15}/></button></div>}
        {pending&&<div className="recovery-banner" role="status"><span>{t('有创建请求尚未确认结果；重试会复用原参数和幂等键。')}</span><button className="button secondary" disabled={!ready||active||submitting||clearing} onClick={()=>void replayController.retryPending()}>{t('重试原创建请求')}</button></div>}
        {model?.replayError&&<div className="error-banner" role="alert">{message(model.replayError)}</div>}
        <div className="section-title"><div><h2>{t('流量实验')}</h2><span>TRAFFIC REPLAY</span></div><span className="section-hint">{t('历史来源 → 打流目标')}</span></div>
        <div className="charts-grid">
          <section className="chart-panel">
            <div className="panel-header"><div><span className="panel-index">01</span><h3>{t('历史流量')}</h3></div><span className="badge neutral">{t(selection?'已固定':'历史查询')}</span></div>
            <div className="panel-model"><strong>{model?.name||t('尚未选择模型')}</strong><span>{dateTime(range.start)} — {range.end-range.start>=86400?dateTime(range.end):clock(range.end)}</span></div>
            <div className="chart-toolbar"><span className="legend"><i className="purple"/>{t('正在处理')}<i className="teal"/>{t('等待处理')}</span><span className="drag-hint">{t('横向拖动选择区间')}</span></div>
            <LoadChart language={language} data={history} range={range} selection={selection} onSelect={select} selectable max={sharedMax}/>
            {history.errors.length>0&&<div className="chart-error" role="alert">{history.errors.map(message).join(language==='zh'?'；':'; ')}</div>}
            {!loading&&!history.running.length&&!history.waiting.length&&<div className="empty-line">{t('此时间范围暂无指标数据')}</div>}
            <div className="selection-form">
              <div className="selection-title"><span><span className="selection-dot"/>{t('回放时间区间')}</span>{selection&&<button onClick={()=>setSelection(undefined)}>{t('清除选区')}</button>}</div>
              <div className="time-inputs"><label>{t('开始时间')}<input type="datetime-local" step="1" value={selection?toInput(selection.start):''} min={toInput(range.start)} max={toInput(range.end)} onChange={e=>changeInput('start',e.target.value)}/></label><span className="time-arrow">→</span><label>{t('结束时间')}<input type="datetime-local" step="1" value={selection?toInput(selection.end):''} min={toInput(range.start)} max={toInput(range.end)} onChange={e=>changeInput('end',e.target.value)}/></label></div>
              <div className="target-choice"><div><label>{t('打流目标')}</label><strong title={targetDisplay||undefined}>{targetDisplay||t('尚未选择目标')}</strong></div><button className="button secondary" type="button" disabled={active||!!pending||submitting||clearing} aria-label={t(targetDisplay?'更换打流目标':'选择打流目标')} onClick={openTargetPicker}><Target size={14}/>{t(targetDisplay?'更换目标':'选择目标')}</button></div>
              <label className="speed-field" htmlFor="replay-speed">{t('回放倍速')}<select id="replay-speed" value={speed} onChange={event=>setSpeed(event.target.value==='burst'?'burst':Number(event.target.value))} disabled={submitting||!!pending}>{[.5,1,2,5,10].map(value=><option key={value} value={value}>{value}×</option>)}<option value="burst">∞</option></select><span>{t(speed==='burst'?'忽略历史请求间隔，一次性发送所选区间的全部请求。':'倍速调整请求间隔，任务开始后保持不变。')}</span></label>
              <div className="selection-footer"><span>{selection?validSelection?t('已选择 {minutes} 分 {seconds} 秒',{minutes:Math.floor((selection.end-selection.start)/60),seconds:Math.round((selection.end-selection.start)%60)}):t('请选择窗口内有效的开始与结束时间'):t('在折线图中拖动，或输入时间')}<small>{t('时间范围包含起点，不包含终点')}</small></span><button className="button primary" onClick={()=>setConfirmOpen(true)} disabled={!validSelection||!canCreate||!targetModel||!!model?.replayError}><Play size={14}/>{t(active?'回放进行中':'确认回放')}</button></div>
            </div>
          </section>
          <section className={`chart-panel replay-panel ${!replay?'no-replay':''}`}>
            <div className="panel-header"><div><span className="panel-index">02</span><h3>{t('回放观测')}</h3></div><div className="panel-header-actions"><span className={`badge ${active?'live':replay?.status==='failed'?'failed':'neutral'}`}>{active&&<i/>}{t(replay?statusNames[replay.status]:'等待回放')}</span><span title={t(clearDisabledReason||'清空当前任务的观测数据')}><button className="button secondary clear-replay" type="button" disabled={!!clearDisabledReason} aria-describedby="clear-replay-hint" onClick={()=>void replayController.clear().then(cleared=>{if(cleared)setConfirmOpen(false);})}>{clearing?<LoaderCircle size={13} className="spin"/>:<Trash2 size={13}/>}<span>{t(clearing?'清空中…':'清空数据')}</span></button></span></div></div>
            <span id="clear-replay-hint" className="sr-only">{t(clearDisabledReason||'清空当前任务的观测数据')}</span>
            {clearNotice&&<div className="replay-clear-notice" role="status"><Check size={14}/>{t(clearNotice)}</div>}
            <div className="panel-model"><strong>{replay?`${replay.sourceModelName||replay.sourceModelId||replay.modelName} → ${replay.modelName}`:t('等待创建回放任务')}</strong><span>{replay?.startedAt!==undefined?t('{time} 开始',{time:dateTime(replay.startedAt)}):t('回放开始后自动获取模型曲线')}</span></div>
            {replay&&<>
              <ReplayProgress replay={replay} language={language}/>
              <div className="chart-toolbar"><span className="legend"><i className="purple"/>{t('正在处理')}<i className="teal"/>{t('等待处理')}</span><label className="relative"><input type="checkbox" checked={relative} onChange={e=>setRelative(e.target.checked)}/>{t('相对时间')}{relative&&replayRange?t('（{unit}）',{unit:relativeTimeUnit(replayRange.end-replayRange.start,language)}):''}</label></div>
              {replayRange?<LoadChart language={language} data={replayData} range={replayRange} relativeOrigin={relative?replay.startedAt:undefined} max={sharedMax}/>:<div className="waiting-replay">
                {!isTerminalReplay(replay.status)&&<LoaderCircle size={24} className="spin"/>}
                <p>{replay.startedAt!==undefined?t('等待回放指标'):replay.requestCount===0?t('此选区没有可回放请求'):isTerminalReplay(replay.status)?t('任务已结束，未开始打流'):replay.requestCount!==undefined?t('已准备 {count} 个请求 · 等待实际打流开始',{count:formatValue(replay.requestCount,0,language)}):t('正在准备请求，统计总数')}</p>
              </div>}
              {replayData.errors.length>0&&<div className="chart-error">{replayData.errors.map(message).join(language==='zh'?'；':'; ')}</div>}
              <div className="task-summary"><div><span>{t('历史区间')}</span><strong>{clock(replay.source.start)} — {clock(replay.source.end)}</strong></div><div><span>{t('回放规则')}</span><strong>{replay.speed==='burst'?'∞':replay.speed!==undefined?t('{speed}× · 按历史间隔调度',{speed:replay.speed}):t('倍速未知')}</strong></div></div>
              <div className="replay-actions"><code title={replay.id}>{replay.id}</code>{active&&<>
                <button className="button secondary cancel-replay" disabled={!ready||!replay.cancellable||cancelling||replay.status==='cancelling'} onClick={()=>void replayController.cancel()}>{cancelling&&<LoaderCircle size={14} className="spin"/>}{t(cancelling?'正在提交取消…':replay.status==='cancelling'?'正在取消':'取消回放')}</button>
              </>}</div>
              {replay.status==='cancelling'&&<div className="replay-caption">{t('已提交的请求仍可能完成；取消期间继续更新进度。')}</div>}
              <div className="replay-caption">{t('已完成包含处理结束的失败请求；任务结果以状态为准。')}</div>
              <div className="replay-caption">{t('实例指标可能包含其他流量；回放尾部指标受采集和缓存延迟影响。')}</div>
            </>}
            {!replay&&<div className="replay-empty"><div className="empty-orbit"><Activity size={28}/><span className="orbit-dot"/></div><h4>{t('让历史流量，再跑一次')}</h4><p>{t('在左侧选定时间区间并确认回放。')}<br/>{t('该模型的新处理与等待曲线将在这里展示。')}</p><div className="empty-steps"><span><span>1</span>{t('选择区间')}</span><span className="step-line"/><span><span>2</span>{t('确认回放')}</span><span className="step-line"/><span><span>3</span>{t('观察效果')}</span></div><div className="empty-tip"><Check size={14}/>{t('切换来源查询不会改变已创建的来源和目标')}</div></div>}
          </section>
        </div>
        <section className="latency-section" aria-label={t('延迟数据')}>
          <div className="section-title"><div><h2>{t('延迟数据')}</h2><span>LATENCY</span></div><span className="section-hint">{t('即时查询 · 回溯 {window}',{window:promDuration(seconds)})}</span></div>
          <div className="metrics-context">{t('{model} · 延迟回溯 {window} · 即时查询',{model:model?.name||t('尚未选择模型'),window:promDuration(seconds)})}</div>
          <div className="metrics-grid">{LATENCY_CARDS.map(card=><LatencyCard key={card.key} metricKey={card.key} metric={metrics[card.key]} loading={metricsLoading} language={language}/>)}</div>
        </section>
        <ReplayLatency key={`latency:${replay?.id||''}:${metricsIdentity}`} replay={replay} api={REPLAY_API} config={REPLAY_LATENCY} language={language} refreshToken={refreshToken}/>
        <ReplayTrend key={`trend:${replay?.id||''}:${metricsIdentity}`} replay={replay} api={REPLAY_API} config={REPLAY_LATENCY} language={language} refreshToken={refreshToken}/>
        <ReplayThroughput key={`throughput:${replay?.id||''}:${metricsIdentity}`} replay={replay} api={THROUGHPUT_API} config={REPLAY_THROUGHPUT} language={language} refreshToken={refreshToken}/>
        <ReplayCache key={`cache:${replay?.id||''}:${metricsIdentity}`} replay={replay} api={REPLAY_API} config={REPLAY_CACHE} language={language} refreshToken={refreshToken} taskStatus={replay ? t(statusNames[replay.status]) : undefined}/>
        <div className="bottom-note"><span>{t('Prometheus 原样数据解析')}</span><span>{updatedAt?t('指标更新于 {time}',{time:clock(updatedAt)}):t('等待指标查询')}<span className="footer-dot">·</span>{t('时间：')}{DISPLAY_TIME_ZONE}</span></div>
      </main>
    </div>
    {targetPickerOpen&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setTargetPickerOpen(false);}}><section className="modal target-picker" role="dialog" aria-modal="true" aria-labelledby="target-picker-title"><button className="modal-close icon-button" aria-label={t('关闭')} onClick={()=>setTargetPickerOpen(false)}><X size={19}/></button><div className="modal-icon"><Target size={21}/></div><h2 id="target-picker-title">{t('选择打流目标')}</h2><p>{t('历史请求从所选来源模型读取，并发送到这里选择的 LiteLLM 目标。')}</p><label className="target-search"><Search size={15}/><input autoFocus type="search" aria-label={t('搜索目标模型')} placeholder={t('搜索目标模型')} value={targetQuery} onChange={event=>setTargetQuery(event.target.value)}/></label><div className="target-picker-toolbar"><span>{targetModelsLoading?t('正在加载目标列表…'):t('{count} 个可用目标',{count:targetModels.length})}</span><button className="icon-button" type="button" title={t('刷新目标列表')} aria-label={t('刷新目标列表')} disabled={targetModelsLoading} onClick={()=>void refreshTargets()}><RefreshCw size={15} className={targetModelsLoading?'spin':''}/></button></div>{targetModelsError?<div className="error-banner" role="alert">{message(targetModelsError)}<button className="button secondary" type="button" onClick={()=>void refreshTargets()}>{t('重试')}</button></div>:targetModelsLoading?<div className="target-empty"><LoaderCircle size={18} className="spin"/>{t('正在加载目标列表…')}</div>:filteredTargets.length?<div className="target-list">{filteredTargets.map(name=><button key={name} className="target-option" type="button" aria-pressed={targetModelId===name} onClick={()=>{setTargetModelId(name);setTargetPickerOpen(false);}}><span>{name}</span>{targetModelId===name&&<Check size={16}/>}</button>)}</div>:<div className="target-empty">{targetModels.length?t('没有匹配的目标模型'):t('没有可用目标模型')}</div>}</section></div>}
    {confirmOpen&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><button className="modal-close icon-button" aria-label={t('关闭')} disabled={submitting} onClick={()=>setConfirmOpen(false)}><X size={19}/></button><div className="modal-icon"><Play size={22}/></div><h2 id="confirm-title">{t('确认回放历史流量')}</h2><p>{t(speed==='burst'?'将所选时间段的全部请求一次性发送到已选目标。':'将所选时间段的请求按所选倍速发送到已选目标。')}</p><dl><dt>{t('来源模型')}</dt><dd>{model?.name}</dd><dt>{t('打流目标')}</dt><dd>{targetModel}</dd><dt>{t('开始时间')}</dt><dd>{selection&&fullDateTime(selection.start)}</dd><dt>{t('结束时间')}</dt><dd>{selection&&fullDateTime(selection.end)}</dd><dt>{t('回放倍速')}</dt><dd>{speed==='burst'?'∞':`${speed}×`}</dd></dl>{(error||actionError)&&<div className="chart-error" role="alert">{message(actionError||error)}</div>}<div className="modal-actions"><button className="button secondary" disabled={submitting} onClick={()=>setConfirmOpen(false)}>{t('取消')}</button><button className="button primary" disabled={submitting||!ready||active||clearing||!targetModel} onClick={()=>pending?void replayController.retryPending():void beginReplay()}>{submitting?<LoaderCircle size={15} className="spin"/>:<Play size={14}/>}{t('开始回放')}</button></div></section></div>}
    {settingsOpen&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="modal-close icon-button" aria-label={t('关闭')} onClick={()=>setSettingsOpen(false)}><X size={19}/></button><h2 id="settings-title">{t('后端连接设置')}</h2>
      <p>{t('模型指标使用 BACKEND_URL；回放可单独配置 REPLAY_BACKEND_URL。修改 .env.local 后重新运行 npm run dev。')}</p>
      {PROXY_AUTH?<p className="settings-note">{t('回放认证由同源服务端代理提供，刷新后自动恢复。')}</p>:<>
      <label className="settings-field">{t('认证头')}<select value={authHeader} onChange={e=>setAuthHeader(e.target.value as typeof authHeader)}><option>Authorization</option><option>x-litellm-key</option><option>x-api-key</option></select></label>
      <label className="settings-field">{t('认证值')}<input type="password" autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={authHeader==='Authorization'?'Bearer <BENCHMARK_API_KEY>':t('回放接口密钥')}/></label>
      {authHeader==='Authorization'&&<p className="settings-note">{t('Benchmark 使用服务端 BENCHMARK_API_KEY。请填写 Bearer 空格加实际密钥，不带尖括号；页面不会自动补前缀。')}</p>}
      <p className="settings-note">{t('回放凭据仅保存在页面内存中，不写入本地存储，不附带到指标查询。')}</p>
      </>}
      <details className="metrics-settings"><summary>{t('指标认证（可选）')}</summary>
        <label>{t('指标认证头')}<select value={metricsHeader} onChange={event=>setMetricsHeader(event.target.value as typeof metricsHeader)}><option>x-api-key</option><option>Authorization</option></select></label>
        <label>{t('指标认证值')}<input type="password" autoComplete="off" value={metricsKey} onChange={event=>setMetricsKey(event.target.value)} placeholder={metricsHeader==='Authorization'?'Bearer <API_KEY>':'API_KEY'}/></label>
        <p>{t('仅用于 Prometheus 查询，留空则不携带认证。凭据仅在页面内存中保存；Authorization 请填写完整 Bearer 值。')}</p>
      </details>
      <div className="endpoint-list"><code title={MODEL_DISCOVERY_QUERY}>{t('模型来源：Prometheus / vLLM')}</code><code>{t('历史指标入口：')}{API.prometheusPrefix}</code><code>{t('回放指标入口：')}{REPLAY_API.prometheusPrefix}</code><code>{t('吞吐指标入口：')}{THROUGHPUT_API.prometheusPrefix}</code><code>/api/models</code><code>{CREATE}</code><code>{ACTIVE}</code><code>{CANCEL}</code>{model&&<><code>model_name = {model.metricsName||model.name}</code><code>source_model = {model.replayModelId||model.id}</code><code>target_model = {targetModel||'未选择'}</code></>}</div><div className="modal-actions"><button className="button primary" disabled={submitting||cancelling||clearing} onClick={()=>{
        const metricsAuth={apiKey:metricsKey.trim(),authHeader:metricsHeader};
        if(metricsAuth.apiKey!==appliedMetrics.current.apiKey || metricsAuth.authHeader!==appliedMetrics.current.authHeader){
          setMetricsAuth(metricsAuth);appliedMetrics.current=metricsAuth;setMetricsIdentity(value=>value+1);setRefreshToken(value=>value+1);
          setHistory(EMPTY);setMetrics(emptyMetrics);setReplayData(EMPTY);
        }
        setAuthSettings({apiKey:apiKey.trim(),authHeader});setSettingsToken(t=>t+1);setSettingsOpen(false);replayController.recover();
      }}>{t('应用设置')}</button></div>
    </section></div>}
  </div>;
}



