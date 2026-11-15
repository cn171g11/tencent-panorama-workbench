/* Validate derived municipal counts before replacing report rows. No point arrays. */
(function(root, factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.PanoMunicipalReport=factory();
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  var names={'110000':'北京市','120000':'天津市','310000':'上海市','500000':'重庆市'};
  var policy='datav-gcj02-polygon-covers-lowest-code-residual-v1';
  function sameCounts(a,b){
    var ka=Object.keys(a||{}).sort(),kb=Object.keys(b||{}).sort();
    return ka.length===kb.length&&ka.every(function(k,i){return k===kb[i]&&a[k]===b[k];});
  }
  function number(n){return Number.isSafeInteger(n)&&n>=0;}
  function sum(rows,key){return rows.reduce(function(s,row){return s+row[key];},0);}
  function apply(provinces,meta,counts,artifact,manifest){
    var unavailable=[];
    Object.keys(names).forEach(function(code){
      var province=names[code],bucket=provinces[province];if(!bucket)return;
      var selected={};
      Object.keys(meta).forEach(function(k){if(meta[k].province===province&&!meta[k].virtual)selected[k]=counts[k];});
      var m=artifact&&artifact.municipalities&&artifact.municipalities[code],valid=true;
      var expectedRegular=0,expectedHidden=0;
      Object.keys(selected).forEach(function(k){if(k==='hidden'||k.indexOf('hidden_')===0)expectedHidden+=selected[k];else expectedRegular+=selected[k];});
      if(!artifact||artifact.version!==1||artifact.policy!==policy||!m||m.name!==province||!sameCounts(selected,m.sourceCounts)||!Array.isArray(m.districts)||!m.districts.length||!m.districts.every(function(d){return d&&typeof d==='object';})||!m.unassigned||typeof m.unassigned!=='object')valid=false;
      if(valid){
        var seen={};
        m.districts.forEach(function(d){
          if(!/^\d{6}$/.test(d.code)||d.code.slice(0,2)!==code.slice(0,2)||seen[d.code]||!d.name||!number(d.regular)||!number(d.hidden)||d.total!==d.regular+d.hidden)valid=false;
          seen[d.code]=true;
        });
        var u=m.unassigned;
        if(!number(u.regular)||!number(u.hidden)||u.total!==u.regular+u.hidden||m.regular!==expectedRegular||m.hidden!==expectedHidden||m.total!==expectedRegular+expectedHidden||sum(m.districts,'regular')+u.regular!==expectedRegular||sum(m.districts,'hidden')+u.hidden!==expectedHidden)valid=false;
      }
      // Published reports must match the exact point bytes in the same manifest,
      // not merely counts. A same-count coordinate/source change is stale too.
      if(manifest === undefined || (manifest !== null && (!manifest || !((manifest.version===1&&manifest.codec==='gzip')||(manifest.version===2&&manifest.codec==='brotli'))))) valid=false;
      if(valid&&manifest){
        var required={};
        Object.keys(selected).forEach(function(k){required[k==='hidden'||k.indexOf('hidden_')===0?'hidden_pano.js':'data_'+k+'.js']=true;});
        Object.keys(required).forEach(function(file){var source=artifact.sources&&artifact.sources[file],live=manifest.files&&manifest.files[file];if(!source||!live||source.sha256!==live.sha256||source.bytes!==live.bytes)valid=false;});
      }
      if(!valid){
        unavailable.push(province);
        // Keep known city totals, never present absent district counts as zero.
        bucket.cities={};bucket.cities[code]={code:code,name:province+'（区级统计未就绪）',regular:expectedRegular,hidden:expectedHidden,total:expectedRegular+expectedHidden};
        bucket.unit='市级';bucket.districtReady=false;return;
      }
      bucket.cities={};
      m.districts.forEach(function(d){bucket.cities[d.code]={code:d.code,name:d.name,regular:d.regular,hidden:d.hidden,total:d.total};});
      if(m.unassigned.total)bucket.cities[code+'-unassigned']={code:code+'-unassigned',name:'未归属区县／边界外',regular:m.unassigned.regular,hidden:m.unassigned.hidden,total:m.unassigned.total,residual:true};
      bucket.unit='区县';bucket.districtReady=true;
      if(bucket.regular!==expectedRegular||bucket.hidden!==expectedHidden)throw Error('Municipality metadata totals changed');
    });
    return {unavailable:unavailable};
  }
  return {apply:apply};
});
