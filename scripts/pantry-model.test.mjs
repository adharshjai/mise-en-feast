import test from 'node:test';
import assert from 'node:assert/strict';
import {currentAmount,allocateIngredient,groupPantry,undoCook,addShoppingItem,dateValue,expiryFromDate,calendarDaysLeft,DAY} from '../frontend/shared/pantry-model.js';
import {createFoodCatalog} from '../frontend/shared/foods.js';
const now=Date.now();
const batch=(overrides={})=>({id:crypto.randomUUID(),key:'bananas',name:'Bananas',initial:2,deducted:0,burn:0,purchase:now,expiry:now+2*DAY,variety:'Regular',unit:'items',...overrides});

test('banana example keeps all three variety/date batches under one food',()=>{
  const items=[batch(),batch({variety:'Organic',initial:3}),batch({variety:'Organic',expiry:now+4*DAY})];
  const groups=groupPantry(items);
  assert.equal(groups.length,1);assert.equal(groups[0].batches.length,3);
  assert.equal(groups[0].batches.reduce((n,x)=>n+currentAmount(x,now),0),7);
  assert.deepEqual(items.map(x=>x.initial),[2,3,2]);
});
test('recipe uses soonest-expiring batches across varieties without over-deducting',()=>{
  const later=batch({expiry:now+4*DAY,initial:3,variety:'Organic'}),early=batch();
  const allocation=allocateIngredient([later,early],'bananas',4,now);
  assert.deepEqual(allocation.allocations.map(x=>[x.item.id,x.servings]),[[early.id,2],[later.id,2]]);
  assert.equal(allocation.missing,0);
  assert.equal(allocateIngredient([early,later],'bananas',8,now).missing,3);
});
test('expired and empty batches cannot satisfy recipes',()=>{
  const old=batch({expiry:now-2*DAY}),empty=batch({deducted:2});
  assert.equal(allocateIngredient([old,empty],'bananas',2,now).missing,2);
});
test('undo restores exact batches and is blocked after a check-in, atomically',()=>{
  const a=batch({deducted:1}),b=batch({deducted:2});
  const log={items_deducted:[{id:a.id,servings:1,purchase:a.purchase},{id:b.id,servings:2,purchase:b.purchase}]};
  b.purchase+=1;
  assert.throws(()=>undoCook([a,b],log),/changed/);assert.equal(a.deducted,1);
  b.purchase-=1;undoCook([a,b],log);
  assert.equal(a.deducted+b.deducted,0);assert.ok(log.undone_at);
  assert.throws(()=>undoCook([a,b],log),/already/);
});
test('shopping deduplicates active needs but allows another after checking off',()=>{
  const list=[];assert.equal(addShoppingItem(list,{key:'banana',name:'Bananas',amount:3,unit:'items'}),true);
  assert.equal(addShoppingItem(list,{key:'banana',name:'Bananas',amount:3,unit:'items'}),false);
  list[0].checked=true;assert.equal(addShoppingItem(list,{key:'banana',name:'Bananas',unit:'items'}),true);
  assert.equal(list.length,2);
});
test('catalog recognizes aliases, organic variants and remote defaults',()=>{
  const base=createFoodCatalog();const banana=base.resolve('bananas');
  const catalog=createFoodCatalog([{...banana,shelf_life_days:9}]);
  assert.equal(catalog.describe('organic banana').key,'bananas');
  assert.equal(catalog.describe('organic banana').variety,'Organic');
  assert.equal(catalog.describe('bananas').shelf,9);
  assert.equal(catalog.key('spaghetti'),catalog.key('pasta'));
  assert.equal(catalog.describe('GV MLK 1GAL').food.id,'milk');
  assert.equal(catalog.describe('Something new').name,'Something new');
});
test('expiration labels use calendar days and round-trip local date inputs',()=>{
  const day=dateValue(now+2*DAY),expiry=expiryFromDate(day);
  assert.equal(dateValue(expiry),day);assert.equal(calendarDaysLeft(expiry,now),2);
});
