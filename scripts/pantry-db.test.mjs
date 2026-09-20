import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const sql=file=>readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';

test('additive migration, atomic saves, RLS, retries and learning in real PostgreSQL',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create schema auth; create role anon; create role authenticated;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
      insert into auth.users values ('${owner}'),('${other}');`);
    for(const file of ['0001_base.sql','0002_foods.sql','0003_intelligence.sql'])await db.exec(await sql(file));
    await db.exec(`insert into public.pantry_items(id,user_id,name,key) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${owner}','Existing pantry','existing');
      insert into public.receipts(user_id,store_name) values ('${owner}','Keep this receipt');
      insert into public.cook_log(user_id,title) values ('${owner}','Keep this meal');`);
    const migration=await sql('0004_pantry_batches.sql');
    await db.exec(migration);await db.exec(migration);
    assert.equal((await db.query('select count(*)::int as n from pantry_items')).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int as n from receipts')).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int as n from cook_log')).rows[0].n,1);
    await db.exec(`grant usage on schema public to authenticated; grant select,insert,update,delete on all tables in schema public to authenticated;
      set role authenticated; set request.jwt.claim.sub='${owner}';`);
    const id=crypto.randomUUID(),cookId=crypto.randomUUID(),receiptId=crypto.randomUUID();
    const row={id,name:'Bananas',key:'bananas',raw_text:'',quantity_label:'3 bananas',initial_servings:3,deducted_servings:0,
      purchase_date:new Date(Date.now()-2*86400000).toISOString(),expiry_date:new Date(Date.now()+3*86400000).toISOString(),
      daily_burn_rate:0,item_type:'event',variety:'Organic',quantity_unit:'items',food_id:'bananas'};
    const state={pantry:[row],shopping:[{id:crypto.randomUUID(),name:'Milk',checked:false}],skipped:[],cooked:['pasta'],chosen:[],
      cookLogs:[{id:cookId,recipe_id:'pasta',title:'Pasta',cooked_at:new Date().toISOString(),items_deducted:[],undone_at:null}],
      receipts:[{id:receiptId,store_name:'Test',total:3,scanned_at:new Date().toISOString(),item_count:1}]};
    const save=state=>db.query('select save_pantry_state($1::jsonb,$2::uuid[])',[JSON.stringify(state),[]]);
    await save(state);await save(state);
    assert.equal((await db.query('select count(*)::int as n from cook_log where id=$1',[cookId])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int as n from receipts where id=$1',[receiptId])).rows[0].n,1);
    assert.equal((await db.query('select variety from pantry_items where id=$1',[id])).rows[0].variety,'Organic');
    const bad=structuredClone(state);bad.pantry[0].variety='Should roll back';bad.cookLogs[0].id='invalid uuid';
    await assert.rejects(save(bad));
    assert.equal((await db.query('select variety from pantry_items where id=$1',[id])).rows[0].variety,'Organic');
    // Passive learning must not count explicit cooking as unexplained consumption.
    await db.query('update pantry_items set initial_servings=10,deducted_servings=4,daily_burn_rate=1 where id=$1',[id]);
    await db.query("select checkin_item($1,'count',4)",[id]);
    const corrected=(await db.query('select * from pantry_items where id=$1',[id])).rows[0];
    assert.equal(Number(corrected.initial_servings),4);assert.equal(Number(corrected.deducted_servings),0);
    assert.equal(new Date(corrected.expiry_date).toISOString(),row.expiry_date);
    const profile=(await db.query("select * from consumption_profiles where scope='food' and key='bananas'")).rows[0];
    assert.ok(Number(profile.learned_daily_rate)>.99 && Number(profile.learned_daily_rate)<=1);
    await assert.rejects(db.query("select checkin_item($1,'percent',2)",[id]));
    await db.exec(`set request.jwt.claim.sub='${other}'`);
    assert.equal((await db.query('select count(*)::int as n from pantry_items')).rows[0].n,0);
    await assert.rejects(save(state));
    assert.equal((await db.query('select count(*)::int as n from app_state')).rows[0].n,0);
    await db.exec(`set request.jwt.claim.sub='${owner}'`);
    state.cookLogs[0].undone_at=new Date().toISOString();await save(state);
    assert.ok((await db.query('select undone_at from cook_log where id=$1',[cookId])).rows[0].undone_at);
  }finally{await db.close();}
});
