import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../frontend/shared/store.js';
const makeState=()=>({pantry:[{id:crypto.randomUUID(),name:'Bananas',key:'bananas',initial:2,deducted:0,burn:0,purchase:Date.now(),expiry:Date.now()+86400000,variety:'Organic',unit:'items'}],shopping:[],skipped:[],cooked:[],chosen:[],cookLogs:[],receipts:[]});
const memory=()=>{const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};};
const uid='11111111-1111-4111-8111-111111111111';
function backend(handler){return {rpc:handler,from(table){const q={select:()=>q,neq:()=>q,order:()=>q,limit:()=>q,maybeSingle:()=>q,then:resolve=>resolve({data:table==='app_state' ? null : [],error:null})};return q;}};}
test('failed save retains latest snapshot, retry is visible and does not duplicate history',async()=>{
  const storage=memory(),calls=[];let fail=true;
  const store=createStore({configured:true,storage,debounceMs:100000,getSession:async()=>({user:{id:uid}}),
    getClient:async()=>backend(async(name,args)=>{calls.push(args);return {error:fail ? new Error('offline') : null};})});
  await store.loadState();const state=makeState();state.cookLogs=[{id:crypto.randomUUID(),items_deducted:[]}];
  store.saveState(state);await assert.rejects(store.flushState(),/offline/);
  assert.equal(store.getStatus().phase,'error');assert.equal(store.hasPending(),true);
  assert.equal(JSON.parse(storage.getItem(`pantry.state.v2:${uid}`)).dirty,true);
  state.shopping.push({id:crypto.randomUUID(),key:'milk',name:'Milk',amount:1,unit:'items'});
  store.saveState(state);fail=false;await store.retrySave();
  assert.equal(store.getStatus().phase,'saved');assert.equal(calls[1].p_state.shopping.length,1);
  assert.equal(calls[0].p_state.cookLogs[0].id,calls[1].p_state.cookLogs[0].id);
  assert.equal(JSON.parse(storage.getItem(`pantry.state.v2:${uid}`)).dirty,false);
});
test('overlapping saves are serialized and finish with the newest state',async()=>{
  let release;const calls=[];
  const store=createStore({configured:true,storage:memory(),debounceMs:100000,getSession:async()=>({user:{id:uid}}),
    getClient:async()=>backend(async(name,args)=>{calls.push(args);if(calls.length===1)await new Promise(r=>release=r);return {error:null};})});
  await store.loadState();const first=makeState();store.saveState(first);const saving=store.flushState();
  while(!release)await new Promise(r=>setTimeout(r,1));
  first.pantry[0].initial=5;store.saveState(first);release();await saving;
  assert.deepEqual(calls.map(x=>x.p_state.pantry[0].initial_servings),[2,5]);
  assert.equal(store.getStatus().phase,'saved');await store.flushState();
});
test('outbox is isolated by account and survives a reload without silently seeding',async()=>{
  const storage=memory();storage.setItem(`pantry.state.v2:${uid}`,JSON.stringify({dirty:true,state:makeState(),knownIds:[]}));
  const store=createStore({configured:true,storage,debounceMs:100000,getSession:async()=>({user:{id:uid}}),getClient:async()=>backend(async()=>({error:null}))});
  assert.equal((await store.loadState()).pantry.length,1);assert.equal(store.hasPending(),true);await store.retrySave();
  const other=createStore({configured:true,storage,getSession:async()=>({user:{id:'other'}}),getClient:async()=>backend(async()=>({error:null}))});
  assert.equal(await other.loadState(),null);
});
test('auth or load failures do not masquerade as a new account',async()=>{
  const store=createStore({configured:true,storage:memory(),getSession:async()=>null,getClient:async()=>null});
  await assert.rejects(store.loadState(),/sign in/);
});
test('demo persists batch details and shopping, and validates check-ins',async()=>{
  const storage=memory(),store=createStore({storage,debounceMs:100000});
  const state=makeState();store.saveState(state);await store.flushState();
  assert.equal((await store.loadState()).pantry[0].variety,'Organic');
  const updated=await store.checkIn(state.pantry[0],'count',1);
  assert.equal(updated.initial,1);assert.equal(updated.expiry,state.pantry[0].expiry);
  await assert.rejects(store.checkIn(state.pantry[0],'percent',2),/valid/);
});
