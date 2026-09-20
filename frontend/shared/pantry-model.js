export const DAY = 86400000;
export const OUT = 0.05;
export const normalizeName = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const currentAmount = (item, now = Date.now()) => Math.max(0, item.initial - item.burn * Math.max(0, (now - item.purchase) / DAY) - item.deducted);

// Keep dates in the user's calendar, including across daylight-saving changes.
export function dateValue(time = Date.now()) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export const expiryFromDate = value => new Date(`${value}T23:59:59`).getTime();
export function calendarDaysLeft(expiry, now = Date.now()) {
  const a = new Date(expiry), b = new Date(now);
  return Math.round((Date.UTC(a.getFullYear(),a.getMonth(),a.getDate()) - Date.UTC(b.getFullYear(),b.getMonth(),b.getDate())) / DAY);
}
export const formatAmount = value => Number(Math.max(0,value).toFixed(1)).toLocaleString();

export function availableBatches(pantry, key, now = Date.now()) {
  return pantry.filter(x => x.key === key && currentAmount(x, now) > OUT && calendarDaysLeft(x.expiry, now) >= 0)
    .sort((a,b) => a.expiry-b.expiry || a.purchase-b.purchase || a.id.localeCompare(b.id));
}

// One recipe ingredient can span multiple varieties and expiration dates.
export function allocateIngredient(pantry, key, need, now = Date.now()) {
  let left = Math.max(0,need);
  const allocations = [];
  for (const item of availableBatches(pantry,key,now)) {
    const servings = Math.min(left,currentAmount(item,now));
    if (servings > 0) allocations.push({item,servings});
    left = Math.max(0,left-servings);
    if (left <= 0.000001) break;
  }
  return {allocations, missing: left, available: availableBatches(pantry,key,now).reduce((n,x)=>n+currentAmount(x,now),0)};
}

export function groupPantry(pantry) {
  const groups = new Map();
  for (const item of pantry) {
    if (!groups.has(item.key)) groups.set(item.key,{key:item.key,name:item.name,batches:[]});
    groups.get(item.key).batches.push(item);
  }
  return [...groups.values()].map(group => ({...group,batches:group.batches.sort((a,b)=>a.expiry-b.expiry || a.variety.localeCompare(b.variety))}))
    .sort((a,b)=>a.name.localeCompare(b.name));
}

export function undoCook(pantry, log) {
  if (!log || log.undone_at) throw new Error('This meal has already been undone.');
  for (const used of log.items_deducted) {
    const item = pantry.find(x=>x.id===used.id);
    if (!item || item.purchase !== used.purchase || item.deducted + 0.000001 < used.servings) {
      throw new Error('A batch from this meal has since been changed or removed. Undo is no longer available.');
    }
  }
  for (const used of log.items_deducted) {
    const item = pantry.find(x=>x.id===used.id);
    item.deducted = Math.max(0,item.deducted-used.servings);
  }
  log.undone_at = new Date().toISOString();
}

export function addShoppingItem(list, {key,name,amount=1,unit='servings'}) {
  const existing = list.find(x=>normalizeName(x.key)===normalizeName(key) && x.unit===unit && !x.checked);
  if (existing) return false; // repeated taps never duplicate the same need
  list.push({id:crypto.randomUUID(),key:normalizeName(key),name,amount,unit,checked:false});
  return true;
}
