const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {apply}=require('../../city-viewer/municipality-report-view.js');
const policy='datav-gcj02-polygon-covers-lowest-code-residual-v1';
const meta={'310000':{name:'上海市',province:'上海市',pref:'310000'},'310000_2':{name:'上海市',province:'上海市',pref:'310000'},qq_31:{name:'腾讯常规',province:'上海市',pref:'qq_31'},hidden_310000:{name:'上海市·隐藏街景',province:'上海市',pref:'hidden_310000'},hidden_310101:{name:'黄浦区·隐藏街景',province:'上海市',pref:'hidden_310101'},'320100':{name:'南京市',province:'江苏省',pref:'320100'},hidden_game:{name:'游戏',province:'腾讯游戏街景',pref:'hidden_game'}};
const counts={'310000':2,'310000_2':1,qq_31:1,hidden_310000:1,hidden_310101:1,'320100':10,hidden_game:15};
const clone=x=>JSON.parse(JSON.stringify(x));
function data(){
 const sources={};for(const f of ['data_310000.js','data_310000_2.js','data_qq_31.js','hidden_pano.js'])sources[f]={sha256:'a'.repeat(64),bytes:100};
 return{version:1,policy,sources,municipalities:{'310000':{name:'上海市',sourceCounts:{'310000':2,'310000_2':1,qq_31:1,hidden_310000:1,hidden_310101:1},districts:[{code:'310101',name:'黄浦区',regular:1,hidden:1,total:2},{code:'310104',name:'徐汇区',regular:2,hidden:1,total:3},{code:'310105',name:'長宁区',regular:0,hidden:0,total:0}],unassigned:{regular:1,hidden:0,total:1},regular:4,hidden:2,total:6}}};
}
function provinces(){return{'上海市':{name:'上海市',cities:{'310000':{code:'310000',name:'上海市',regular:3,hidden:1,total:4},'310101':{code:'310101',name:'黄浦区',regular:0,hidden:1,total:1}},regular:4,hidden:2,total:6},'江苏省':{name:'江苏省',cities:{'320100':{code:'320100',name:'南京市',regular:10,hidden:0,total:10}},regular:10,hidden:0,total:10}};}
test('district rows replace mixed city rows without changing totals and retain real zero and residual',()=>{
 const p=provinces(),before=clone(p['江苏省']);const a=data();assert.deepEqual(apply(p,meta,counts,a,null),{unavailable:[]});
 assert.deepEqual([p['上海市'].regular,p['上海市'].hidden,p['上海市'].total],[4,2,6]);
 assert.deepEqual(p['江苏省'],before);assert.equal(p['上海市'].cities['310104'].regular,2);assert.equal(p['上海市'].cities['310105'].regular,0);assert.equal(p['上海市'].cities['310000'],undefined);assert.equal(p['上海市'].cities['310000-unassigned'].regular,1);
});
for(const broken of ['missing','counts','sum','duplicate','hash','bytes'])test('unavailable/stale '+broken+' preserves city totals, never fake district zero',()=>{
 const p=provinces(),a=data(),manifest={version:2,codec:'brotli',files:clone(a.sources)};
 if(broken==='counts')a.municipalities['310000'].sourceCounts.qq_31=2;
 if(broken==='sum')a.municipalities['310000'].districts[0].regular=2;
 if(broken==='duplicate')a.municipalities['310000'].districts[2].code='310104';
 if(broken==='hash')manifest.files['hidden_pano.js'].sha256='b'.repeat(64);
 if(broken==='bytes')manifest.files['hidden_pano.js'].bytes=101;
 const status=apply(p,meta,counts,broken==='missing'?undefined:a,manifest);assert.deepEqual(status.unavailable,['上海市']);
 assert.deepEqual(Object.keys(p['上海市'].cities),['310000']);assert.equal(p['上海市'].cities['310000'].regular,4);assert.match(p['上海市'].cities['310000'].name,/未就绪/);
});
test('published source hashes and bytes all match before district data is accepted',()=>{const a=data(),p=provinces();assert.deepEqual(apply(p,meta,counts,a,{version:2,codec:'brotli',files:clone(a.sources)}),{unavailable:[]});});

test('malformed manifest or null district row fails closed instead of crashing or accepting stale data',()=>{
 for(const manifest of [false,{}, {version:99,codec:'brotli',files:{}}]){const p=provinces();assert.deepEqual(apply(p,meta,counts,data(),manifest),{unavailable:['上海市']});}
 const p=provinces(),a=data();a.municipalities['310000'].districts[0]=null;assert.deepEqual(apply(p,meta,counts,a,null),{unavailable:['上海市']});
});

test('missing manifest fails closed while explicit source-checkout null mode is supported',()=>{
 const p=provinces();assert.deepEqual(apply(p,meta,counts,data(),undefined),{unavailable:['上海市']});assert.equal(p['上海市'].cities['310101'],undefined);
});

const html=fs.readFileSync(path.resolve(__dirname,'../../city-viewer/report.html'),'utf8');
const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
function fixture(artifact=data(), withModule=true){
 const elements={};for(const m of html.matchAll(/\bid="([^"]+)"/g))elements[m[1]]={innerHTML:'',textContent:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}};
 const window={PANO_META:clone(meta),PANO_COUNT:clone(counts),PANO_MUNICIPAL_REPORT:artifact,PanoMunicipalReport:withModule?{apply}:undefined,PANO_ASSET_MANIFEST:null,CHANGELOG:[]};
 const document={getElementById:id=>elements[id],querySelectorAll:()=>[]};vm.runInNewContext(inline,{window,document});
 return{elements,window};
}
test('report searches districts, sorts, filters hidden and preserves national total using metadata only',()=>{
 assert(!/<script[^>]+src="(?:grid_all|hidden_pano|pano_search_index|data_(?!meta|districts))/.test(html));
 const h=fixture();assert.match(h.elements.cards.innerHTML,/31/,'National total 6+10+15');
 h.elements.q.listeners.input({target:{value:'徐汇'}});assert.match(h.elements.rows.innerHTML,/徐汇区/);assert.match(h.elements.rows.innerHTML,/class="num-reg">2</);assert(!h.elements.rows.innerHTML.includes('南京市'));
 h.elements.sort.listeners.change({target:{value:'regular'}});assert.match(h.elements.rows.innerHTML,/徐汇区/);
 h.elements.onlyHidden.listeners.change({target:{checked:true}});assert.match(h.elements.rows.innerHTML,/徐汇区/);
 h.elements.q.listeners.input({target:{value:'長宁'}});assert.match(h.elements.rows.innerHTML,/没有匹配|上海市/);assert(!h.elements.rows.innerHTML.includes('<tr class="city"><td>長宁区'));
});
test('report missing display module collapses municipal mixed rows to city totals',()=>{
 const h=fixture(data(),false);
 h.elements.q.listeners.input({target:{value:'上海'}});
 h.elements.rows.listeners.click({target:{closest(){return{getAttribute(){return'上海市';}};}}});
 assert.match(h.elements.note.textContent,/未就绪/);assert.match(h.elements.rows.innerHTML,/区级统计未就绪/);assert(!h.elements.rows.innerHTML.includes('黄浦区'));assert.match(h.elements.rows.innerHTML,/class="num-reg">4</);
});

test('report missing artifact clearly reports unavailable statistics and does not show district fake zeros',()=>{
 const h=fixture(null);h.elements.q.listeners.input({target:{value:'上海'}});
 h.elements.rows.listeners.click({target:{closest(){return{getAttribute(){return'上海市';}};}}});
 assert.match(h.elements.note.textContent,/未就绪/);assert.match(h.elements.rows.innerHTML,/区级统计未就绪/);assert(!h.elements.rows.innerHTML.includes('黄浦区'));
});
