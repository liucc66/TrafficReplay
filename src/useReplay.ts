import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request, type ClientOptions } from './data';
import { applyReplayResponse, isTerminalReplay, restoreReplay } from './replay';
import { clearReplaySnapshot, readPending, readSnapshot, savePending, saveSnapshot, type PendingReplay, type ReplayBody } from './replayStorage';
import { createUuid } from './uuid';
import type { Replay } from './types';

export interface ReplayPaths { create: string; status: string; active: string; cancel: string }
const lightweight=(path:string)=>path+(path.includes('?')?'&':'?')+'view=status';
const taskPath=(path:string,id:string)=>path.replace('{id}',encodeURIComponent(id));

export function useReplay({auth,authReady,scope,paths,metricsMap}:{auth:ClientOptions;authReady:boolean;scope:string;paths:ReplayPaths;metricsMap:Record<string,string>}) {
  const [replay,setReplay]=useState<Replay | undefined>(()=>readSnapshot(scope).replay);
  const replayRef=useRef<Replay | undefined>(replay);
  const [backendPending,setBackendPending]=useState<PendingReplay | undefined>(()=>readPending(scope));
  const pending=backendPending;
  const pendingRef=useRef(backendPending);
  const [ready,setReady]=useState(false);
  const [restoring,setRestoring]=useState(false);
  const [recoveryError,setRecoveryError]=useState('');
  const [actionError,setActionError]=useState('');
  const [submitting,setSubmitting]=useState(false);
  const [cancelling,setCancelling]=useState(false);
  const [clearing,setClearing]=useState(false);
  const [clearNotice,setClearNotice]=useState('');
  const [restoredId,setRestoredId]=useState<string>();
  const [recoveryToken,setRecoveryToken]=useState(0);
  const [pollToken,setPollToken]=useState(0);
  const authRef=useRef(auth);authRef.current={...auth,service:'replay'};
  const epoch=useRef(0), actionBusy=useRef(false), cancelBusy=useRef(false);
  const authSignature=`${auth.authHeader}:${auth.apiKey || ''}:${authReady}`;
  const setTask=useCallback((task:Replay | undefined)=>{
    replayRef.current=task;setReplay(task);
    if(task)setClearNotice('');
    saveSnapshot(scope,{...readSnapshot(scope),replay:task});
  },[scope]);
  const setOperation=useCallback((op:PendingReplay | undefined)=>{
    pendingRef.current=op;setBackendPending(op);savePending(scope,op);
  },[scope]);
  useEffect(()=>{
    const op=readPending(scope);pendingRef.current=op;setBackendPending(op);
  },[scope]);
  const adopt=useCallback((raw:unknown,restored:boolean,fallback?:Replay)=>{
    const task=restoreReplay(raw,metricsMap,fallback);
    setTask(task);if(restored)setRestoredId(task.id);
    return task;
  },[metricsMap,setTask]);

  useEffect(()=>{
    const token=++epoch.current;let live=true;
    setActionError('');setRecoveryError('');setRestoredId(undefined);setClearNotice('');
    setReady(false);
    const cached=readSnapshot(scope).replay;
    setTask(cached);
    if(!authReady){setRestoring(false);setRecoveryError('请先在连接设置中填写认证值，再恢复任务。');return()=>{live=false;};}
    setRestoring(true);
    const current=()=>live && epoch.current===token;
    void (async()=>{
      try {
        const active=await request(lightweight(paths.active),{},authRef.current);
        if(!current())return;
        if(active?.active === true){
          adopt(active.task,true,cached);
          // 新建冲突可能来自其他标签页；待确认操作必须保留，不能误认它已成功。
        } else if(active?.active === false && active?.task == null){
          if(cached?.id){
            try {
              const raw=await request(lightweight(taskPath(paths.status,cached.id)),{},authRef.current);
              if(!current())return;
              adopt(raw,true,cached);
            } catch(e){
              if(!current())return;
              if(e instanceof ApiError && e.status===404)setTask(undefined);else throw e;
            }
          } else setTask(undefined);
        } else throw new Error('活动任务响应格式无效');
        if(current())setReady(true);
      } catch(e){if(current())setRecoveryError(`恢复回放失败：${(e as Error).message}`);}
      finally {if(current())setRestoring(false);}
    })();
    return()=>{live=false;};
  },[scope,paths.active,paths.status,authSignature,recoveryToken,adopt,setTask]);

  useEffect(()=>{
    const id=replay?.id;
    if(!id || !ready || !authReady)return;
    let live=true,busy=false,failures=0,backoffUntil=0,timer:number|undefined;
    const schedule=(delay:number)=>{clearTimeout(timer);timer=window.setTimeout(()=>void poll(),delay);};
    const poll=async()=>{
      const previous=replayRef.current;
      if(!live||busy||document.hidden||previous?.id!==id||isTerminalReplay(previous.status))return;
      if(cancelBusy.current){schedule(2000);return;}
      if(Date.now()<backoffUntil){schedule(backoffUntil-Date.now());return;}
      busy=true;const token=epoch.current;
      try{
        const raw=await request(lightweight(taskPath(paths.status,id)),{},authRef.current);
        const latest=replayRef.current;
        if(!live||epoch.current!==token||latest?.id!==id)return;
        const task=applyReplayResponse(raw,latest,undefined,metricsMap);
        setTask(task);failures=0;backoffUntil=0;
      }catch(e){
        if(!live||epoch.current!==token||replayRef.current?.id!==id)return;
        setTask({...replayRef.current,statusError:`任务状态查询失败：${(e as Error).message}`});
        failures++;
        if(e instanceof ApiError && (e.status===401||e.status===403||e.status===404)){
          setReady(false);setRecoveryError(`恢复回放失败：${e.message}`);return;
        }
        backoffUntil=Date.now()+(e instanceof ApiError&&e.status===429?e.retryAfterMs || 60000:Math.min(30000,5000*2**Math.min(failures-1,3)));
      }finally{
        busy=false;
        if(live&&!document.hidden&&replayRef.current?.id===id&&!isTerminalReplay(replayRef.current.status))schedule(Math.max(2000,backoffUntil-Date.now()));
      }
    };
    const visible=()=>{if(!document.hidden){clearTimeout(timer);void poll();}};
    void poll();document.addEventListener('visibilitychange',visible);
    return()=>{live=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[replay?.id,ready,authSignature,pollToken,paths.status,metricsMap,setTask]);

  const submit=async(op:PendingReplay)=>{
    if(actionBusy.current || cancelBusy.current || !ready || (replayRef.current&&!isTerminalReplay(replayRef.current.status)))return;
    actionBusy.current=true;setSubmitting(true);setActionError('');
    const token=epoch.current,retrying=pendingRef.current?.key===op.key;
    try{
      setOperation(op);
      const raw=await request(paths.create,{method:'POST',headers:{'Idempotency-Key':op.key},body:op.signature},authRef.current);
      if(epoch.current!==token)return;
      adopt(raw,false,op.context);setOperation(undefined);
    }catch(e){
      if(epoch.current!==token)return;
      if(e instanceof ApiError && e.status===409 && e.payload?.active_task){
        try{adopt(e.payload.active_task,true);setOperation(undefined);}catch(error){setActionError((error as Error).message);}
      }else{
        // 已有未确认尝试时，即使本次被拒绝，也不能据此断定原请求没有创建任务。
        if(!retrying&&e instanceof ApiError&&e.payload&&
          [400,401,403,404,405,413,415,422].includes(e.status))setOperation(undefined);
        setActionError(`创建回放失败：${(e as Error).message}`);
      }
    }finally{actionBusy.current=false;setSubmitting(false);}
  };
  const begin=async(body:ReplayBody,context:Replay)=>{
    try {
      const signature=JSON.stringify(body),existing=pendingRef.current;
      if(existing && existing.signature!==signature){setActionError('存在结果待确认的创建请求，请先重试原请求。');return;}
      await submit(existing || {key:createUuid(),signature,body,context});
    } catch(e) {
      setActionError(`创建回放失败：${(e as Error).message}`);
    }
  };
  const retryPending=async()=>{if(pendingRef.current)await submit(pendingRef.current);};
  const cancel=async()=>{
    const task=replayRef.current;
    if(!task || !task.cancellable || cancelBusy.current || actionBusy.current || !ready)return;
    cancelBusy.current=true;setCancelling(true);setActionError('');const token=++epoch.current;
    try{
      const raw=await request(taskPath(paths.cancel,task.id),{method:'POST'},authRef.current);
      if(epoch.current===token&&replayRef.current?.id===task.id)setTask(applyReplayResponse(raw,replayRef.current,undefined,metricsMap));
    }catch(e){
      if(epoch.current!==token||replayRef.current?.id!==task.id)return;
      if(e instanceof ApiError&&e.status===409&&e.payload?.task){
        try {
          setTask(applyReplayResponse(e.payload.task,replayRef.current,undefined,metricsMap));
          if(!isTerminalReplay(replayRef.current!.status))setActionError(`取消回放失败：${e.message}`);
        } catch(error) {setActionError(`取消回放失败：${(error as Error).message}`);}
      }else setActionError(`取消回放失败：${(e as Error).message}`);
    }finally{cancelBusy.current=false;setCancelling(false);setPollToken(value=>value+1);}
  };
  const clearDisabledReason=clearing?'正在清空数据'
    : submitting?'正在创建任务，无法清空数据'
    : restoring || !ready || recoveryError?'请先完成任务恢复，再清空数据'
    : pending?'创建结果尚未确认，无法清空数据'
    : cancelling || replay && !isTerminalReplay(replay.status)?'任务尚未结束，无法清空数据'
    : !replay?'暂无可清空的回放数据':'';
  const clear=async()=>{
    const task=replayRef.current;
    if(clearDisabledReason || !task || !isTerminalReplay(task.status) || actionBusy.current || cancelBusy.current || pendingRef.current)return false;
    actionBusy.current=true;setClearing(true);setActionError('');setClearNotice('');
    const token=epoch.current;
    const current=()=>epoch.current===token && replayRef.current?.id===task.id;
    try{
      {
        const active=await request(lightweight(paths.active),{cache:'no-store'},authRef.current);
        if(!current())return false;
        if(active?.active===true){
          // 其他页面可能已创建任务；完整校验，不能拿旧任务上下文补齐新任务。
          const activeTask=restoreReplay(active.task,metricsMap);
          if(isTerminalReplay(activeTask.status))throw new Error('活动任务响应格式无效');
          setTask(activeTask);setRestoredId(activeTask.id);
          throw new Error('检测到活动任务，已恢复观测，请等待任务结束后再清空。');
        }
        if(active?.active!==false || active.task!=null)throw new Error('活动任务响应格式无效');
        if(pendingRef.current || readPending(scope))throw new Error('创建结果尚未确认，无法清空数据');
        clearReplaySnapshot(scope);
      }
      // 同步更新引用并使旧状态响应失效；指标组件随任务移除清理轮询和旧响应。
      ++epoch.current;setTask(undefined);setRestoredId(undefined);setClearNotice('已清空回放数据');
      return true;
    }catch(e){
      if(epoch.current===token)setActionError(`清空数据失败：${(e as Error).message}`);
      return false;
    }finally{actionBusy.current=false;setClearing(false);}
  };
  return {replay,replayRef,ready,restoring,recoveryError,actionError,pending,submitting,cancelling,clearing,clearNotice,clearDisabledReason,restoredId,begin,cancel,clear,retryPending,recover:()=>setRecoveryToken(value=>value+1),clearActionError:()=>setActionError('')};
}
