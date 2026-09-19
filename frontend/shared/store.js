/* Persistence for demo and signed-in pantries. Failed saves retain the latest
   snapshot in a per-user outbox; retries use stable IDs and one DB transaction. */
import { configured, getClient, getSession } from './supabase.js';

export const LOCAL_KEY = 'pantry.state.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v,fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const iso = time => new Date(time).toISOString();
const ids = value => Array.from(value || [],String);
export function normalizeItem(item) {
  return {
    id:UUID.test(item.id) ? item.id : crypto.randomUUID(), name:String(item.name || ''), key:String(item.key || item.name || '').toLowerCase(),
    qty:String(item.qty || ''), raw:String(item.raw || ''), initial:Math.max(0,num(item.initial,1)),
    purchase:num(item.purchase,Date.now()), expiry:num(item.expiry,Date.now()+7*86400000),
    burn:Math.max(0,num(item.burn)), deducted:Math.max(0,num(item.deducted)),
    variety:String(item.variety || 'Regular'), unit:item.unit==='items' ? 'items' : 'servings', foodId:item.foodId || null,
  };
}
export function fromRow(row) {
  return normalizeItem({id:row.id,name:row.name,key:row.key,qty:row.quantity_label,raw:row.raw_text,
    initial:row.initial_servings,deducted:row.deducted_servings,purchase:Date.parse(row.purchase_date),
    expiry:row.expiry_date ? Date.parse(row.expiry_date) : undefined,burn:row.daily_burn_rate,
    variety:row.variety,unit:row.quantity_unit,foodId:row.food_id});
}
export function toRow(item) {
  return {id:item.id,name:item.name,key:item.key,quantity_label:item.qty,raw_text:item.raw,
    initial_servings:item.initial,deducted_servings:item.deducted,purchase_date:iso(item.purchase),
    expiry_date:iso(item.expiry),daily_burn_rate:item.burn,item_type:item.burn>0 ? 'continuous' : 'event',
    variety:item.variety,quantity_unit:item.unit,food_id:item.foodId};
}
function normalizeState(s) {
  return {pantry:(s.pantry || []).map(normalizeItem),skipped:ids(s.skipped),cooked:ids(s.cooked),chosen:ids(s.chosen),
    shopping:(s.shopping || []).map(x=>({id:UUID.test(x.id) ? x.id : crypto.randomUUID(),key:String(x.key),name:String(x.name),
      amount:Math.max(.01,num(x.amount,1)),unit:String(x.unit || 'servings'),checked:!!x.checked})),
    cookLogs:structuredClone(s.cookLogs || []),receipts:structuredClone(s.receipts || [])};
}

export function createStore({configured=false,getClient,getSession,storage=globalThis.localStorage,debounceMs=400}={}) {
  let user=null, knownIds=new Set(), pending=null, running=null, timer=null;
  let status={phase:'loading',message:'Loading pantry…'};
  const listeners=new Set();
  const publish=(phase,message)=>{status={phase,message};listeners.forEach(fn=>fn(status));};
  const cacheKey=()=>user ? `pantry.state.v2:${user.id}` : LOCAL_KEY;
  const readCache=()=>{try {return JSON.parse(storage?.getItem(cacheKey()) || 'null');} catch {return null;}};
  const cache=(state,dirty)=>storage?.setItem(cacheKey(),JSON.stringify(user ? {state,dirty,knownIds:[...knownIds]} : state));
  async function clientForUser() {
    if (!configured) return null;
    const session=await getSession();
    if(!session?.user || (user && user.id!==session.user.id)) throw new Error('Please sign in again before saving.');
    user=session.user;
    return getClient();
  }
  const failed=error=>publish('error',error?.code==='PGRST202' || error?.code==='42703' || error?.code==='PGRST204'
    ? 'Account update needed. Changes are kept on this device.' : 'Not saved. Your changes are waiting to sync.');
  async function loadState() {
    if(!configured) {const saved=readCache();publish('local','Saved on this device');return saved ? normalizeState(saved) : null;}
    try {
      const client=await clientForUser();
      const [items,meta,logs]=await Promise.all([
        client.from('pantry_items').select('*').neq('status','gone').order('created_at',{ascending:true}),
        client.from('app_state').select('*').maybeSingle(),
        client.from('cook_log').select('*').order('cooked_at',{ascending:false}).limit(20),
      ]);
      for(const result of [items,meta,logs]) if(result.error) throw result.error;
      knownIds=new Set(items.data.map(x=>x.id));
      const draft=readCache();
      if(draft?.dirty && draft.state) {pending=normalizeState(draft.state); publish('error','Recovered unsaved changes. Retry to sync.'); return pending;}
      if(!items.data.length && !meta.data) {publish('saved','All changes saved');return null;}
      const state=normalizeState({...meta.data,pantry:items.data.map(fromRow),cookLogs:logs.data,receipts:[]});
      cache(state,false);publish('saved','All changes saved');return state;
    } catch(error) {
      failed(error);
      // Only a cache belonging to this signed-in user may be recovered.
      const draft=user && readCache();
      if(draft?.dirty && draft.state) {knownIds=new Set(draft.knownIds || []);pending=normalizeState(draft.state);return pending;}
      throw error;
    }
  }
  function saveState(state) {
    pending=normalizeState(state);
    state.pantry.forEach((x,i)=>{x.id=pending.pantry[i].id;});
    try {cache(pending,true);} catch {publish('error','Device storage is full. Keep this tab open until saved.');}
    if(timer) clearTimeout(timer);
    publish('saving',configured ? 'Saving…' : 'Saving on this device…');
    timer=setTimeout(()=>flushState().catch(()=>{}),debounceMs);
  }
  async function flushState() {
    if(timer) {clearTimeout(timer);timer=null;}
    if(running) {await running; if(pending) return flushState(); return;}
    if(!pending) return;
    const snapshot=pending;pending=null;
    running=(async()=>{
      try {
        if(configured) {
          const client=await clientForUser();
          const currentIds=new Set(snapshot.pantry.map(x=>x.id));
          const {error}=await client.rpc('save_pantry_state',{
            p_state:{...snapshot,pantry:snapshot.pantry.map(toRow)},p_deleted_ids:[...knownIds].filter(id=>!currentIds.has(id)),
          });
          if(error) throw error;
          knownIds=currentIds;
        }
        cache(pending || snapshot,!!pending);
        if(!pending) publish(configured ? 'saved' : 'local',configured ? 'All changes saved' : 'Saved on this device');
      } catch(error) {
        if(!pending) pending=snapshot;
        failed(error);throw error;
      }
    })();
    try {await running;} finally {running=null;}
    if(pending) return flushState();
  }
  async function checkIn(item,style,value) {
    if(!['count','percent','empty'].includes(style) || (style!=='empty' && (!Number.isFinite(value)||value<0||(style==='percent'&&value>1)))) throw new Error('Enter a valid remaining amount.');
    await flushState();
    const amount=style==='empty' ? 0 : style==='percent' ? item.initial*value : value;
    if(!configured) return amount<=.05 ? null : {...item,initial:amount,deducted:0,purchase:Date.now()};
    const client=await clientForUser();
    // Absolute quantities make a retry safe even if the previous response was lost.
    const {error}=await client.rpc('checkin_item',{p_item_id:item.id,p_style:style==='empty' ? 'empty' : 'count',p_value:amount});
    if(error) throw error;
    const row=await client.from('pantry_items').select('*').eq('id',item.id).single();
    if(row.error) throw row.error;
    return row.data.status==='gone' ? null : fromRow(row.data);
  }
  async function loadFoods() {
    if(!configured) return [];
    const client=await clientForUser();
    const {data,error}=await client.from('foods').select('*').order('name');
    if(error) throw error;
    return data;
  }
  return {loadState,saveState,flushState,retrySave:flushState,checkIn,loadFoods,
    subscribe(fn){listeners.add(fn);fn(status);return()=>listeners.delete(fn);},
    getStatus:()=>status,
    clearLocal(){storage?.removeItem(cacheKey());},
    hasPending:()=>!!(pending||running),
  };
}
const store=createStore({configured,getClient,getSession});
export const {loadState,saveState,flushState,retrySave,checkIn,loadFoods,subscribe,getStatus,clearLocal}=store;
if(typeof window!=='undefined') {
  window.addEventListener('online',()=>store.retrySave().catch(()=>{}));
  window.addEventListener('pagehide',()=>store.flushState().catch(()=>{}));
  window.addEventListener('beforeunload',event=>{if(store.hasPending()){event.preventDefault();event.returnValue='';}});
}
