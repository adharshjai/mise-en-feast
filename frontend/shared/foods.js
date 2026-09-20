import { FALLBACK_FOODS } from './food-catalog.js';
import { normalizeName } from './pantry-model.js';

const title = text => text.charAt(0).toUpperCase()+text.slice(1);
export function createFoodCatalog(remote = []) {
  const rows = new Map(FALLBACK_FOODS.map(food=>[food.id,food]));
  remote.forEach(food=>rows.set(food.id,food));
  const foods = [...rows.values()];
  function resolve(input) {
    const value = normalizeName(input);
    if (!value) return null;
    const plain = value.replace(/\b(?:organic|org|regular)\b/g,'').replace(/\s+/g,' ').trim();
    const exact = foods.find(f=>[f.id,f.id.replaceAll('-',' '),f.name,...f.aliases].some(a=>normalizeName(a)===plain));
    if (exact) return exact;
    const candidates = foods.flatMap(f=>[f.name,f.id.replaceAll('-',' '),...f.aliases].map(alias=>({food:f,alias:normalizeName(alias)})))
      .filter(x=>x.alias.length>2).sort((a,b)=>b.alias.length-a.alias.length);
    return candidates.find(({alias})=>new RegExp(`(?:^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:$|\\s|\\d)`).test(plain))?.food || null;
  }
  function describe(input) {
    const food = resolve(input);
    const key = food ? food.id.replaceAll('-',' ') : normalizeName(input);
    return {
      food, key, name:title(key), foodId:food?.id || null,
      variety:/\b(org|organic)\b/i.test(input) ? 'Organic' : 'Regular',
      shelf:Number(food?.shelf_life_days ?? 7), burn:Number(food?.default_daily_rate ?? 0),
      servings:Number(food?.default_servings ?? 1), qty:food?.default_unit || '',
      unit:food?.checkin_style==='count' ? 'items' : 'servings',
    };
  }
  return {foods,resolve,describe,key:input=>describe(input).key};
}
