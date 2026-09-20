// Run against a disposable demo browser with gstack browse eval.
return (async () => {
  const results = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); results.push(label); };
  const click = selector => { const el = document.querySelector(selector); if (!el) throw new Error(`Missing ${selector}`); el.click(); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { state } = window.pantry;
  window.PANTRY_CONFIG.apiBaseUrl = '';
  state.prefs = (await import('/shared/store.js')).normalizePrefs({});
  window.pantry.openOnboarding();
  click('[data-ob-step="adults"][data-dir="1"]');
  click('[data-ob-step="kids"][data-dir="1"]');
  click('[data-ob-next]');
  click('[data-ob-toggle="allergies"][data-value="peanuts"]');
  click('[data-ob-next]');
  click('[data-ob-toggle="cuisines"][data-value="italian"]');
  click('[data-ob-next]');
  click('[data-ob-set="skill"][data-value="beginner"]');
  click('[data-ob-next]');
  click('[data-ob-done]');
  await wait(450);
  assert(state.prefs.onboarded && state.prefs.allergies.includes('peanuts'), 'Onboarding saves allergies');
  assert(state.prefs.cuisines.includes('italian') && state.prefs.skill === 'beginner', 'Cuisine and kitchen preferences survive');
  assert(JSON.parse(localStorage.getItem('pantry.prefs.v1')).household.kids === state.prefs.household.kids, 'Preferences persist locally');
  click('#btn-profile');
  click('[data-profile="preferences"]');
  assert(state.sheet === 'profile', 'Profile menu opens preference summary');
  click('[data-ob-edit="0"]');
  click('[data-ob-skip]');
  await wait(450);
  // Details open from the top card itself (a tap, or ArrowUp); there is no details button any more.
  window.pantry.setTab('curated');
  assert(state.deck.length > 0, 'The curated deck has a dish to open');
  window.pantry.openDetail(state.deck[0]);
  await wait(450);
  const target = Math.ceil(state.prefs.household.adults + state.prefs.household.kids / 2);
  assert(state.detailServings === target && !document.querySelector('#sheet').textContent.includes('NaN'), 'Household object produces valid recipe servings');
  click('[data-serv="1"]');
  assert(state.detailServings === target + 1, 'Recipe serving controls work');
  click('[data-madeit]');
  assert(state.sheet === 'madeit', 'Scaled recipe opens pantry deduction confirmation');
  click('[data-close]');
  await wait(450);
  // The pantry is a section now: its tab opens it, the Curated tab leaves it.
  click('#tabs [data-tab="pantry"]');
  assert(state.tab === 'pantry' && !document.querySelector('#pantry-screen').classList.contains('hidden'), 'Pantry tab shows the pantry page');
  for (const tab of ['amount', 'category', 'expiring']) {
    click(`[data-ptab="${tab}"]`);
    assert(state.panelTab === tab, `Pantry ${tab} tab works`);
  }
  click('#tabs [data-tab="curated"]');
  assert(state.tab === 'curated', 'Curated tab leaves the pantry page');
  click('#btn-scan');
  assert(state.sheet === 'scan-choose', 'Scan offers receipt and dish flows');
  click('[data-choose-dish]');
  click('[data-dish-sample]');
  await wait(3500);
  click('[data-dish-save]');
  await wait(500);
  if (state.sheet) click('[data-close]');
  await wait(450);
  click('#btn-saved');
  click('[data-open-saved-dish]');
  assert(state.sheet === 'detail' && state.detailFromSaved, 'Saved photo recipe opens with serving controls');
  click('[data-serv="1"]');
  assert(document.querySelector('[data-open-saved]'), 'Serving changes preserve Back to saved');
  click('[data-madeit]');
  assert(state.sheet === 'madeit', 'Photo recipe staples do not crash pantry confirmation');
  return results;
})()
