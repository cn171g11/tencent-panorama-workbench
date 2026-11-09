#!/usr/bin/env node
// Real Chromium/Edge verification of a gzip-only local artifact or its live URL.
// A local preview exists only during this test; it does not replace the DSH GUI.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');
const args = process.argv.slice(2);
function arg(name, fallback) { const i=args.indexOf(name); return i<0?fallback:args[i+1]; }
const sourceRoot=path.resolve(arg('--source','city-viewer'));
const sourceHTML=fs.readFileSync(path.join(sourceRoot,'index.html'),'utf8');
const sourceVersion=sourceHTML.match(/<span class="ver">(v\d+\.\d+\.\d+)<\/span>/)?.[1];
if(!sourceVersion)throw Error('Source viewer version is missing');
const metaText=fs.readFileSync(path.join(sourceRoot,'data_meta.js'),'utf8');
const countMarker='window.PANO_COUNT=';
const countOffset=metaText.indexOf(countMarker);
if(countOffset<0)throw Error('Source PANO_COUNT is missing');
const sourceCounts=JSON.parse(metaText.slice(countOffset+countMarker.length).split(';')[0]);
const expectedVersion=arg('--expected-version',sourceVersion);
const expectedTotal=Number(arg('--expected-total',Object.values(sourceCounts).reduce((a,b)=>a+b,0)));
const expectedFiles=Number(arg('--expected-files',Object.keys(sourceCounts).filter(k=>k!=='hidden'&&!k.startsWith('hidden_')).length+3));
const siteRoot=arg('--site-root',null);
const liveUrl=arg('--url',null);
const edge=arg('--browser','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const vendorRoot=path.resolve(arg('--vendor-root','dist/browser-vendor'));
const resultRoot=path.resolve(arg('--result-dir','dist/browser-check'));
if(Boolean(siteRoot)===Boolean(liveUrl)) throw Error('Choose --site-root or --url');
if(fs.existsSync(resultRoot)) throw Error('Choose a new result directory; refusing to overwrite');
fs.mkdirSync(resultRoot,{recursive:true});
const profile=fs.mkdtempSync(path.join(resultRoot,'profile-'));
const source=fs.readFileSync(path.join(sourceRoot,'data_532600.js'),'utf8');
const marker='window.PANO_CITY["532600"]=';
const rows=JSON.parse(source.slice(source.indexOf(marker)+marker.length).trim().replace(/;\s*$/,''));
const target=rows[0];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let server,browser,ws,nextId=1;
const pending=new Map(), requests=[], exceptions=[];
const report={targetSid:target[0],checks:{},viewports:[]};
async function until(fn,timeout=120000){ const start=Date.now(); let last; while(Date.now()-start<timeout){last=await fn();if(last)return last;await delay(250);}throw Error('Timed out waiting for browser state'); }
function send(method,params={}){
 const id=nextId++;
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},120000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
async function main(){
 let pageURL=liveUrl;
 if(siteRoot){
  const root=path.resolve(siteRoot);
  server=http.createServer((req,res)=>{
   const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
   let file;
   if(pathname.startsWith('/test-vendor/'))file=path.join(vendorRoot,path.basename(pathname));
   else {file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep)&&file!==root){res.writeHead(403);res.end();return;}if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');}
   if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
   const type=file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.gz')?'application/gzip':'text/javascript; charset=utf-8';
   res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});
   if(file.endsWith('city-viewer'+path.sep+'index.html')){
    // Mirror the same pinned Leaflet files for deterministic local testing only.
    let text=fs.readFileSync(file,'utf8').replace('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js','/test-vendor/leaflet.js').replace('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css','/test-vendor/leaflet.css');res.end(text);
   } else fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  pageURL='http://127.0.0.1:'+server.address().port+'/city-viewer/';
 }
 report.url=pageURL;
 browser=spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
 browser.on('error',error=>{report.spawnError=error.message;});
 const portFile=path.join(profile,'DevToolsActivePort');
 await until(async()=>fs.existsSync(portFile),30000);
 const port=fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0];
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 const tab=pages.find(p=>p.type==='page'); assert(tab,'No browser tab');
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',event=>{
  const x=JSON.parse(event.data);
  if(x.id){const p=pending.get(x.id);if(!p)return;clearTimeout(p.timer);pending.delete(x.id);if(x.error)p.reject(Error(x.error.message));else p.resolve(x.result||{});}
  else if(x.method==='Network.requestWillBeSent'){requests.push(x.params.request.url);}
  else if(x.method==='Runtime.exceptionThrown'){exceptions.push(x.params.exceptionDetails.exception?.description||x.params.exceptionDetails.text);}
 });
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
 await send('Network.setBlockedURLs',{urls:['*is.autonavi.com*','*map.gtimg.com*','*dbankcdn.cn*']});
 await send('Page.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
 // Capture the actual Leaflet map for deterministic click tests; no viewer code is changed.
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`(function(){var value;Object.defineProperty(window,'L',{configurable:true,get:function(){return value;},set:function(v){value=v;if(v&&typeof v.map==='function'){var old=v.map;v.map=function(){var m=old.apply(this,arguments);window.__GZIP_TEST_MAP__=m;return m;};}}});})();`});
 await send('Page.navigate',{url:pageURL});
 await until(()=>evaluate(`Boolean(window.PANO_ASSET_MANIFEST&&window.PANO_ASSET_MANIFEST.codec==='gzip'&&window.__GZIP_TEST_MAP__&&document.getElementById('search')&&!document.getElementById('search').disabled&&document.getElementById('stats').textContent.includes('点'))`));
 report.checks.boot=await evaluate(`({version:document.querySelector('.ver').textContent,total:Object.values(window.PANO_COUNT).reduce((a,b)=>a+b,0),files:Object.keys(window.PANO_ASSET_MANIFEST.files).length,searchIndexLoaded:Boolean(window.PANO_SEARCH_INDEX),hiddenGame:window.PANO_CITY.hidden_game.length,stats:document.getElementById('stats').textContent})`);
 assert.equal(report.checks.boot.version,expectedVersion);assert.equal(report.checks.boot.total,expectedTotal);assert.equal(report.checks.boot.files,expectedFiles);assert.equal(report.checks.boot.searchIndexLoaded,false);assert.equal(report.checks.boot.hiddenGame,15);
 assert(!requests.some(u=>u.includes('pano_search_index.js.gz')),'Index downloaded before a query');
 // Render the real isolated game collection in scatter mode and inspect its red hits.
 await evaluate(`(function(){var p=document.getElementById('provinceSelect');p.value=window.PANO_META.hidden_game.province;p.dispatchEvent(new Event('change'));var c=document.getElementById('citySelect');c.value='hidden_game';c.dispatchEvent(new Event('change'));var d=document.getElementById('dispMode');d.value='points';d.dispatchEvent(new Event('change'));})()`);
 await until(()=>evaluate(`Object.values(window.__GZIP_TEST_MAP__._layers).some(l=>l._hits&&l._hits.length===15)`));
 report.checks.game=await evaluate(`(function(){var l=Object.values(window.__GZIP_TEST_MAP__._layers).find(l=>l._hits&&l._hits.length===15);return {points:l._hits.length,redFlags:l._hits.filter(p=>p[3]).length};})()`);
 assert.equal(report.checks.game.redFlags,15);
 async function query(q,note){await evaluate(`(function(){var e=document.getElementById('search');e.value=${JSON.stringify(q)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await until(()=>evaluate(`document.getElementById('stats').textContent.includes('搜索命中 1 条')&&document.getElementById('stats').textContent.includes(${JSON.stringify(note)})`));}
 await query(target[0],'panoid 搜索');
 const positions=await evaluate(`(function(){var l=Object.values(window.__GZIP_TEST_MAP__._layers).find(l=>l._hits&&l._hits.length===1);return l?l._hits[0].slice(0,2):null;})()`);
 assert(positions);assert.equal(positions[0],target[2]);assert.equal(positions[1],target[1]);
 await evaluate(`void window.__GZIP_TEST_MAP__.fire('click',{latlng:window.L.latLng(${target[2]},${target[1]})})`);
 assert(await evaluate(`document.querySelector('.pv-meta .pid').textContent===${JSON.stringify(target[0])}`));
 report.checks.panoid={sid:target[0],coordinates:positions,exactNumericValues:true};
 await query('@1-23:'+target[0],'panoid 定位');report.checks.positionQuery=true;
 for(const width of [560,705,1280,1440]){
  await send('Page.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
  await until(()=>evaluate(`Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--header-h'))-document.querySelector('header').offsetHeight)<1`),10000);
  const box=await evaluate(`(function(){var r=document.getElementById('search').getBoundingClientRect();return {width:innerWidth,inputLeft:r.left,inputRight:r.right,inputWidth:r.width,headerHeight:document.querySelector('header').offsetHeight};})()`);
  assert(box.inputWidth>100&&box.inputLeft>=0&&box.inputRight<=width+1,'Search layout overflow at '+width);report.viewports.push(box);
  if(width===560||width===1280){const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(resultRoot,'viewer-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 }
 const gzipRequests=requests.filter(u=>/\.js\.gz(?:\?|$)/.test(u));
 const rawLarge=requests.filter(u=>/\/(?:data_(?!meta|districts)[A-Za-z0-9_]+|hidden_pano|grid_all|pano_search_index)\.js(?:\?|$)/.test(u));
 assert(gzipRequests.some(u=>u.includes('pano_search_index.js.gz')));assert(gzipRequests.some(u=>u.includes('data_532600.js.gz')));assert.equal(rawLarge.length,0,'Raw large script was requested');
 assert.equal(exceptions.length,0,'Browser runtime exceptions: '+exceptions.join('\n'));
 report.checks.gzipRequests=gzipRequests.map(u=>new URL(u).pathname);report.checks.rawLargeRequests=rawLarge;report.checks.runtimeExceptions=exceptions;
 report.passed=true;fs.writeFileSync(path.join(resultRoot,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,url:pageURL,version:report.checks.boot.version,total:report.checks.boot.total,gzipFiles:report.checks.boot.files,query:target[0],gzipRequests:gzipRequests.length,report:path.join(resultRoot,'report.json')}));
}
main().catch(error=>{report.error=error.stack;report.passed=false;fs.writeFileSync(path.join(resultRoot,'report.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;}).finally(async()=>{for(const p of pending.values())clearTimeout(p.timer);if(ws)ws.close();if(browser)browser.kill();if(server)await new Promise(resolve=>server.close(resolve));});
