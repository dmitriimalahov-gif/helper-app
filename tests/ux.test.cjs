const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const D = require('../drafts.js');
class Storage {
  m = new Map(); get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i]; }
  getItem(k) { return this.m.get(k) ?? null; }
  setItem(k,v) { this.m.set(k,v); }
  removeItem(k) { this.m.delete(k); }
}
test('drafts survive reload, stay isolated by account/car/company/editor, and clear after save', () => {
  const s = new Storage();
  assert.equal(D.put(s,'driver:a:car1','rec',{shop:'Garage',parts:'500'}),true);
  assert.deepEqual(D.get(s,'driver:a:car1','rec'),{shop:'Garage',parts:'500'});
  for (const [scope,kind] of [['driver:b:car1','rec'],['driver:a:car2','rec'],['driver:a:car1','fuel'],['partner:a:car1','rec']]) assert.equal(D.get(s,scope,kind),null);
  D.drop(s,'driver:a:car1','rec'); assert.equal(D.get(s,'driver:a:car1','rec'),null);
});
test('expired, future, malformed and oversized drafts fail safely; quota failure is reported', () => {
  const s = new Storage(); D.put(s,'a','b',{x:1}); const k=s.key(0);
  for (const v of ['{','null',JSON.stringify({v:1,at:Date.now()-8*86400000,data:{x:1}}),JSON.stringify({v:1,at:Date.now()+10000,data:{x:1}})]) {s.setItem(k,v); assert.equal(D.get(s,'a','b'),null);}
  assert.equal(D.put(s,'a','b',{x:'x'.repeat(50001)}),false);
  assert.equal(D.put({get length(){throw Error('blocked')}},'a','b',{}),false);
});
test('bounded storage retains other application data', () => {
  const s=new Storage();s.setItem('account','untouched');
  for(let i=0;i<80;i++)D.put(s,'a','entry'+i,{i});
  assert.equal(s.length,65);assert.equal(s.getItem('account'),'untouched');assert.equal(D.get(s,'a','entry79').i,79);
});
const driver=fs.readFileSync(require.resolve('../index.html'),'utf8');
const partner=fs.readFileSync(require.resolve('../partner/index.html'),'utf8');
function run(src,ctx) { vm.createContext(ctx);vm.runInContext(src,ctx);return ctx; }
function between(src,a,b) { return src.slice(src.indexOf(a),src.indexOf(b,src.indexOf(a))); }
test('reuse selects same car/category, preserves entered metadata and does not reuse costs/date/mileage',()=>{
 const fields=Object.fromEntries(['brand','shop','phone','parts','labor','date','odo','more'].map(k=>['#rec-'+k,{value:''}]));
 fields['#rec-brand'].value='My oil';fields['#rec-parts'].value='900';fields['#rec-date'].value='2026-10-18';fields['#rec-odo'].value='99999';
 const rows=[{carId:'a',cat:'oil',date:'2026-09-01',shop:'Recent',phone:'123',brand:'Other',parts:100},{carId:'b',cat:'oil',date:'2026-10-01',shop:'Wrong car'},{carId:'a',cat:'tires',date:'2026-10-02',shop:'Wrong work'}];
 const c=run(between(driver,'function recPrevious()','function recSheet('),{$:k=>fields[k],val:k=>k==='rec-cat'?'oil':fields['#'+k]?.value,carRecs:id=>rows.filter(r=>r.carId===id),activeCar:()=>({id:'a'}),byDateDesc:(a,b)=>b.date.localeCompare(a.date),entryDraftSave:()=>{},toast:()=>{},t:k=>k});
 c.recReuse();assert.equal(fields['#rec-shop'].value,'Recent');assert.equal(fields['#rec-brand'].value,'My oil');assert.equal(fields['#rec-parts'].value,'900');assert.equal(fields['#rec-date'].value,'2026-10-18');assert.equal(fields['#rec-odo'].value,'99999');
});
test('new entry draft excludes photos and passwords, clears on success, preserves fuel calculation mode',()=>{
 const storage=new Storage(),form={dataset:{draftScope:'driver:a:c',form:'fuel'}},fields={};
 for(const k of ['date','odo','sum','liters','price','cur','full','station'])fields['#fuel-'+k]={value:{sum:'500',liters:'20',price:'25'}[k]||'',dataset:{auto:k==='liters'?'1':''},type:k==='full'?'checkbox':'text',checked:true};
 const c=run(between(driver,'const ENTRY_FIELDS =','function recPrevious()'),{HelperDrafts:D,localStorage:storage,window:{HelperDrafts:D},$:k=>k.includes('form[')?form:fields[k],FQ:{typed:'sum',receipt:'private-photo'},t:k=>k});
 c.entryDraftSave();const d=D.get(storage,'driver:a:c','fuel');assert.equal(d.litersAuto,'1');assert.equal(d.typed,'sum');assert.ok(!JSON.stringify(d).includes('private-photo'));c.entryDraftDone('fuel');assert.equal(D.get(storage,'driver:a:c','fuel'),null);
});
function business() {
 const c={HelperDrafts:D,localStorage:new Storage(),window:{HelperDrafts:D},DEMO:{on:false},A:{user:{id:1}},st:{pid:10},$:(s)=>s==='#pe-form'?{}:null,ACTS:{},LANGS:['ru','ro','en'],ED:null,PE:null,edRender:()=>{},toast:()=>{},tx:k=>k,tl:(l,k,p)=>l+':'+k+':'+p.value,cur:()=> 'MDL'};
 return run(between(partner,'function businessDraftScope()','let ED = null;'),c);
}
test('business drafts restore point price and translations, never caches or other company data',()=>{
 const c=business();const fresh={id:null,status:'draft',points:null,coupon_days:7,title:'',i18n:{},lang:'ru',_key:'new'};
 const e=c.businessDraftRestore('perk',{...fresh});c.PE={...e,points:35,coupon_days:'12',title:'Gift',i18n:{en:{title:'Gift'}},_tpls:['cache']};c.businessDraftSave();
 const restored=c.businessDraftRestore('perk',{...fresh});assert.equal(restored.points,35);assert.equal(restored.coupon_days,'12');assert.equal(restored.title,'Gift');assert.equal(restored._tpls,undefined);assert.equal(restored.i18n.en.title,'Gift');
 c.st.pid=11;assert.equal(c.businessDraftRestore('perk',{...fresh}).title,'');
 c.st.pid=10;c.A.user.id=2;assert.equal(c.businessDraftRestore('perk',{...fresh}).title,'');
 c.A.user.id=1;c.businessDraftDone('perk',e);assert.equal(c.businessDraftRestore('perk',{...fresh}).title,'');
});
test('demo and already saved business items do not autosave local drafts',()=>{
 const c=business();c.PE={id:null,_draftScope:c.businessDraftScope(),_key:'new',title:'Demo'};c.DEMO.on=true;c.businessDraftSave();assert.equal(c.localStorage.length,0);
 c.DEMO.on=false;c.PE.id=12;c.businessDraftSave();assert.equal(c.localStorage.length,0);
});
test('text preparation fills 3 languages, preserves written fields and uses chosen discount',()=>{
 const c=business();c.ED={kind:'discount',discount_value:15,discount_kind:'percent',lang:'ru',title:'My headline',text:'',i18n:{ro:{title:'Titlu',text:'Condiții'}}};c.edTextTemplate();
 assert.equal(c.ED.title,'My headline');assert.ok(c.ED.text.endsWith(':15%'));assert.equal(c.ED.i18n.ro.text,'Condiții');assert.ok(c.ED.i18n.en.title.startsWith('en:'));assert.ok(c.ED.i18n.en.text.endsWith(':15%'));
});
test('maintenance drafts do not replace a different explicit service and completion retains other work',()=>{
 const storage=new Storage(),form={dataset:{}},fields={'#rec-cat':{value:'pads'},'#rec-more':{},'#rec-x-tires':{},'#rec-x-wheels':{},'#entry-draft-note':{}};
 D.put(storage,'driver:1:c','rec',{cat:'oil',shop:'Oil garage'});D.put(storage,'driver:1:c','rec:oil',{cat:'oil',shop:'Oil garage'});
 const c=run(between(driver,'const ENTRY_FIELDS =','function recPrevious()'),{HelperDrafts:D,localStorage:storage,window:{HelperDrafts:D},$:k=>k.includes('form[')?form:fields[k],A:{user:{id:1}},activeCar:()=>({id:'c'}),val:k=>fields['#'+k]?.value||'',t:k=>k});
 c.entryDraftRestore('rec','pads');assert.equal(fields['#rec-cat'].value,'pads');
 D.put(storage,'driver:1:c','rec:pads',{cat:'pads'});c.entryDraftDrop('driver:1:c','rec','pads');assert.equal(D.get(storage,'driver:1:c','rec:pads'),null);assert.equal(D.get(storage,'driver:1:c','rec').cat,'oil');
});
