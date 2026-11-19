import { productSourceReview } from './product-source-review.js';
import { projectionReview } from './projection-review.js';
import { workflowScenarios } from './workflow-scenarios.js';
import { withProductionLinks } from './production-links.js';
import { bindTrace } from './trace.js';
import { apiBase } from './config.js';

async function request(path, options) {
  const response = await fetch(apiBase + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}

let G;
try {
  G = withProductionLinks(await request('/api/graph'));
} catch (error) {
  document.body.prepend(Object.assign(document.createElement('p'), {
    role: 'alert', textContent: '图谱加载失败，请检查 API 服务后刷新。' + error.message
  }));
  throw error;
}
const P = Object.fromEntries(G.products.map(p=>[p.code,p]));
const $ = s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc = s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const MODULES = G.modules;
const sharedProducts=new Set(['sm','wf','bd']);

/* ---------- interface persistence ---------- */
let ifaces = G.interfaces.slice();

/* ---------- stats & taxonomy & product list ---------- */
const featCount = G.modules.reduce((a,m)=>a+m.features.length,0);
$('#stats').innerHTML = [
  [G.products.filter(p=>!sharedProducts.has(p.code)).length,'业务产品'],[G.modules.length,'模块'],[featCount,'功能点'],
  [G.existingLinks.length,'现有联动'],[G.suggestedLinks.length,'MOM建议'],[G.qa.length,'问答条目']
].map(x=>`<div class="stat"><div class="n">${x[0]}</div><div class="l">${x[1]}</div></div>`).join('');
$('#ifCnt').textContent=ifaces.length;
$('#qaCnt').textContent=G.qa.length;

/* ---------- view switching ---------- */
let curView='graph';
function switchView(v){
  curView=v;
  $$('.nav-item[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view===v));
  $$('.view').forEach(x=>x.classList.remove('active'));
  $('#view-'+v).classList.add('active');
  $('#viewTitle').textContent={graph:'知识图谱',trace:'业务全追溯',interface:'接口管理',qa:'功能知识问答库'}[v];
  $('#exportIf').style.display=v==='interface'?'inline-block':'none';
  if(v==='graph') setTimeout(resizeGraph,30);
  if(v==='interface') renderIfaces();
}
$$('.nav-item[data-view]').forEach(n=>n.onclick=()=>switchView(n.dataset.view));

/* ================= UNIFIED GRAPH ENGINE ================= */
const svg=$('#graph');
let W=0,H=0,scale=1,tx=0,ty=0;
let nodes=[],edges=[],nodeMap={};
const organizationModels=new Set(['sm-M1','sm-M2','sm-M3']);
const sharedScopes={
  'shared-system':{label:'系统功能',matches:m=>m.code==='wf'||(m.code==='sm'&&!organizationModels.has(m.id))},
  'shared-data':{label:'业务基础数据',matches:m=>m.code==='bd'||organizationModels.has(m.id)},
};
const businessProducts=G.products.filter(p=>!sharedProducts.has(p.code));
const modelsInScope=scope=>MODULES.filter(sharedScopes[scope]?.matches||((m)=>m.code===scope));
const scopeName=scope=>sharedScopes[scope]?.label||P[scope]?.name||'';
let dim='product', focusId=null, focusEdge=null, productScope=businessProducts[0]?.code||G.products[0]?.code;
const rememberedModules=new Map();
const allModels='all-models';
const graphHistory=[];
const graphBack=$('#graphBack');

function currentGraphLocation(){
  return {dim,productScope,scope:$('#scopeSel').value,scale,tx,ty,focusId,edge:edges[focusEdge]?.data,edgeKey:edges[focusEdge]?.key,
    positions:new Map(nodes.map(n=>[n.id,{x:n.x,y:n.y}]))};
}
graphBack.onclick=()=>{
  const previous=graphHistory.pop();
  graphBack.disabled=!graphHistory.length;
  if(!previous)return;
  $('#drawer').classList.remove('open');
  productScope=previous.productScope;
  if(previous.dim==='function')rememberedModules.set(productScope,previous.scope);
  setDim(previous.dim);
  ({scale,tx,ty}=previous);
  focusId=nodeMap[previous.focusId]?.id||null;
  if(previous.edge||previous.edgeKey){
    const index=edges.findIndex(e=>previous.edgeKey?e.key===previous.edgeKey:e.data===previous.edge);
    if(index>=0)focusEdge=index;
  }
  nodes.forEach(n=>Object.assign(n,previous.positions.get(n.id)));
  renderGraph();
};
const showExist=()=>$('#tgExist').checked;
const showPlanning=()=>$('#tgPlanning').checked;
const evidenceName=e=>e.evidence==='planning'?'规划参考图':e.evidence==='reviewed'?'现有功能说明':'手册场景';
const linkKind=e=>e.type==='sugg'||e.evidence==='planning'?'planning':'exist';
const linkVisible=kind=>kind==='planning'?showPlanning():showExist();
const isProjected=e=>Boolean(projectionReview(e));

function currentLinks({applyFilters=true}={}){
  return [
    ...G.existingLinks.map(e=>({...e,kind:'exist'})),
    ...G.suggestedLinks.map(e=>({...e,kind:'planning'})),
    ...G.productLinks.map(e=>({...e,kind:linkKind(e)})),
  ].filter(e=>{
    const mapping=projectedInterfaceByRelation.get(productRelationKey(e.source,e.target,e.label));
    return (!applyFilters||linkVisible(e.kind))&&!sharedProducts.has(e.source)&&!sharedProducts.has(e.target)&&
      productSourceReview(mapping?.interfaceId)?.supported!==false;
  });
}

function productRelationType(link){
  if(/读取|取值|引用|校验状态/.test(link.scenario||'') ||
     ['主数据','数据底座','质量状态'].includes(link.aspect))return '业务引用';
  return '业务协同';
}

function groupedProductEdges(links){
  const groups=new Map();
  for(const link of links){
    if(link.source===link.target)continue;
    const key=JSON.stringify([link.source,link.target].sort());
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(link);
  }
  return [...groups].map(([key,items])=>{
    const {source:a,target:b}=items[0];
    const types=[...new Set(items.map(productRelationType))];
    const label=types.join(' / ');
    const directionKind=source=>items.some(e=>e.source===source&&e.kind==='exist')?'exist':'planning';
    return {a,b,key,product:true,links:items,label,
      bidirectional:items.some(e=>e.source===b&&e.target===a),
      forwardKind:directionKind(a),reverseKind:directionKind(b),
      kind:items.some(e=>e.kind==='exist')?'exist':'planning'};
  });
}

const productRelationKey=(source,target,label)=>JSON.stringify([source,target,label]);
const projectedInterfaceByRelation=new Map(G.featureRefs.filter(isProjected).map(ref=>[
  productRelationKey(ref.source,ref.target,ref.label),ref,
]));

function productInterfaceMarkup(link,item){
  const mapping=projectedInterfaceByRelation.get(productRelationKey(link.source,link.target,item.label));
  if(!mapping)return '';
  const registered=ifaces.find(row=>row.id===mapping.interfaceId);
  const review=projectionReview(mapping);
  const source=productSourceReview(mapping.interfaceId);
  const sourceMarkup=source?`<p><strong>${source.supported?'手册依据':'产品方向待核验'}</strong> · ${esc(source.source)}<br>${esc(source.scope)}</p>`:'';
  if(!registered)return `${sourceMarkup}<p class="dir">当前未找到原登记 ${esc(mapping.interfaceId)}。</p>`;
  const endpointsMatch=registered.from===link.source&&registered.to===link.target;
  const summary=endpointsMatch
    ? `台账状态：${registered.status||'未填写'} · 功能映射：${review.label}`
    : '此接口当前登记的产品方向与原场景不同，请核对是否仍适用。';
  return `${sourceMarkup}<p class="dir">${esc(summary)}</p>
    <button class="icon-btn" type="button" data-if="${esc(registered.id)}">查看接口台账 ${esc(registered.id)}</button>`;
}

function openProductRelation(edge){
  const directions=[edge.links.filter(e=>e.source===edge.a),edge.links.filter(e=>e.source===edge.b)];
  const sections=directions.filter(items=>items.length).map(items=>{
    const {source,target}=items[0];
    return `<div class="sec"><h5>${esc(P[source].name)} → ${esc(P[target].name)}</h5>
      ${items.map(e=>{
        const rows=e.scenarios||[{scene:e.aspect||e.momConcept,label:e.label,basis:e.basis||e.rationale}];
        return rows.map(item=>{
          const match=e.reference&&G.featureRefs.find(r=>r.source===source&&r.target===target&&r.scene===item.scene&&r.basis===item.basis);
          const endpoints=match?[match.sourceFeature,match.targetFeature].map(id=>FEAT_BY_ID[id]).filter(Boolean):[];
          return `<div class="link-row ${e.kind==='exist'?'exist':'sugg'}">
          <div class="dir">${e.kind==='exist'?'现有':'规划'} · ${esc(productRelationType(e))}</div>
          ${item.scene?`<strong>${esc(item.scene)}</strong>`:''}
          <div class="txt">${esc(item.label)}${item.basis?`<br>${esc(item.basis)}`:''}</div>
          ${endpoints.map(f=>`<button class="icon-btn" type="button" data-locate-feature="${esc(f.id)}"
            title="${esc(scopeName(f.code))} / ${esc(f.modName)}">定位 ${esc(f.name)}</button>`).join('')}
          ${productInterfaceMarkup(e,item)}
        </div>`;
        }).join('');
      }).join('')}</div>`;
  });
  openDrawer(edge.label,edge.kind==='exist'?'#0d9488':'#2563eb',
    `${P[edge.a].name} ${edge.bidirectional?'↔':'→'} ${P[edge.b].name}`,
    '产品级关系',[{key:'details',label:'业务场景'}],{details:()=>sections.join('')});
}

// build dataset per dimension
const MOD_BY_ID = Object.fromEntries(MODULES.map(m=>[m.id,m]));
const FEAT_BY_ID = Object.fromEntries(MODULES.flatMap(m=>m.features.map(f=>[f.id,{...f,modId:m.id,modName:m.name,code:m.code}])));

function buildGraphData(){
  edges=[]; nodeMap={}; focusId=null; focusEdge=null;
  if(dim==='product'){
    edges=groupedProductEdges(currentLinks());
    const deg=Object.fromEntries(businessProducts.map(p=>[p.code,0]));
    edges.forEach(e=>{deg[e.a]++;deg[e.b]++;});
    nodes=businessProducts.map(p=>({id:p.code,label:p.short,sub:p.name,color:p.color,tier:p.tier,group:p.group,
      deg:deg[p.code],r:16+Math.min(14,deg[p.code]*1.5),type:'product',data:p}));
  } else {
    const scope=$('#scopeSel').value;
    const modules=dim==='module';
    const local=modules ? modelsInScope(scope)
      : scope===allModels ? modelsInScope(productScope).flatMap(m=>m.features)
      : MOD_BY_ID[scope]?.features || [];
    const catalog=modules ? MOD_BY_ID : FEAT_BY_ID;
    const ids=new Set(local.map(item=>item.id));
    const key=modules ? 'Module' : 'Feature';
    const refs=modules ? G.moduleRefs : G.featureRefs;
    const showProjected=$('#tgProjected').checked;
    edges=refs.flatMap(r=>{
      const a=r['source'+key], b=r['target'+key];
      const kind=linkKind(r);
      const review=projectionReview(r);
      if(review?.rejected||(!showProjected&&review)||!linkVisible(kind)||a===b||!catalog[a]||!catalog[b]||(!ids.has(a)&&!ids.has(b)))return [];
      return [{a,b,kind,data:r,ref:true,label:r.scenarios?.length>1?`${r.scenarios.length} 个业务场景`:r.scene||r.label}];
    });
    const allIds=new Set([...ids,...edges.flatMap(e=>[e.a,e.b])]);
    nodes=[...allIds].map((id,i)=>{
      const item=catalog[id];
      const external=!ids.has(id);
      return {id,label:external?P[item.code].short:(modules?'M':'F')+(i+1),
        sub:item.name,color:P[item.code].color,r:modules?15:13,
        type:modules?(external?'extmodule':'module'):(external?'extfunction':'function'),
        data:item,prod:item.code,external,mod:item.modName,modId:modules?id:item.modId};
    });
  }
  nodeMap=Object.fromEntries(nodes.map(n=>[n.id,n]));
  const pairs=new Map();
  edges.forEach(e=>{
    const key=JSON.stringify([e.a,e.b].sort());
    if(!pairs.has(key))pairs.set(key,[]);
    pairs.get(key).push(e);
  });
  pairs.forEach(group=>group.forEach((e,i)=>{
    e.curve=(i-(group.length-1)/2)*(e.a<e.b?1:-1);
  }));
  updateGraphMeta();
}

  function updateGraphMeta(){
  const noRef = dim==='function' && !edges.some(e=>e.ref);
  const hints={product:'单击聚焦（无关节点淡出） · 双击产品下钻模块 · 点击连线看谁引用谁 · 拖拽弹性动画',
    module:'双击业务模型查看功能 · 双击外部模型切换范围 · 点击连线高亮业务场景 · 拖拽弹性动画',
    function:noRef?'所选范围暂无已登记的功能关系 · 可切换业务模型'
      :'节点=功能点 · 连线=功能间引用（谁引用谁） · 点击连线高亮业务场景 · 双击功能看详情/进入其模块'};
  $('#graphHint').textContent=hints[dim];
  const refLegend=`<div class="row"><span class="nd" style="border:2px dashed #64748b;background:transparent"></span>${dim==='module'?'外部业务模型':'外部功能点'}</div>`;
  const curColor = dim==='function'
    ? (P[(MOD_BY_ID[$('#scopeSel').value]||{}).code]||{}).color||'#0891b2'
    : (dim==='module' ? (P[$('#scopeSel').value]||{}).color||'#7c3aed' : '#2563eb');
  const nodeLegend={
    product:'<div class="row"><span class="nd"></span>产品节点（大小=联动度）</div>',
    module:`<div class="row"><span class="nd" style="background:${curColor}"></span>本产品业务模型</div>${refLegend}`,
    function:`<div class="row"><span class="nd" style="background:${curColor}"></span>所选范围功能</div>${refLegend}`,
  };
  $('#legend').innerHTML=`<div class="ttl">图例</div>${nodeLegend[dim]}
    <div class="row"><span class="ln"></span>现有</div>
    <div class="row"><span class="ln planning"></span>规划</div>`;
  const refs=edges.filter(e=>e.ref).length;
  $('#graphStat').textContent=`${nodes.length} ${dim==='module'?'模型':dim==='function'?'功能':'产品'}节点 · ${dim==='product'?edges.length:refs} 条关系`;
}

function layout(){
  const w=W||900,h=H||650,cx=w/2,cy=h/2;
  nodes.forEach((n,i)=>{const a=2*Math.PI*i/nodes.length;n.x=cx+Math.cos(a)*Math.min(w,h)*0.3;n.y=cy+Math.sin(a)*Math.min(w,h)*0.3;n.vx=0;n.vy=0});
  const isFunc=(dim==='function');
  for(let it=0;it<340;it++){
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i],b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
      const rep=(isFunc?11000:9000)/(d*d);
      a.vx-=rep*dx/d;a.vy-=rep*dy/d;b.vx+=rep*dx/d;b.vy+=rep*dy/d;
    }
    edges.forEach(e=>{
      const a=nodeMap[e.a],b=nodeMap[e.b];if(!a||!b)return;
      const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
      const f=(d-230)*0.006;a.vx+=f*dx/d;a.vy+=f*dy/d;b.vx-=f*dx/d;b.vy-=f*dy/d;
    });
    nodes.forEach(n=>{
      if(n.external){
        const dx=n.x-cx,dy=n.y-cy,d=Math.hypot(dx,dy)||1;
        const target=Math.min(w,h)*0.4;
        const f=(target-d)*0.02;
        n.vx+=f*dx/d;n.vy+=f*dy/d;
      } else if(isFunc){
        // 功能维度本模块功能点向中心聚拢，形成"本模块功能簇"
        n.vx+=(cx-n.x)*0.012;n.vy+=(cy-n.y)*0.012;
      }
      n.vx+=(cx-n.x)*0.003;n.vy+=(cy-n.y)*0.003;n.vx*=.82;n.vy*=.82;n.x+=n.vx;n.y+=n.vy;
      n.x=Math.max(40,Math.min(w-40,n.x));n.y=Math.max(30,Math.min(h-30,n.y));
    });
  }
}

function focusSet(){
  if(focusEdge!==null){const e=edges[focusEdge];return new Set([e.a,e.b])}
  if(!focusId)return null;
  const set=new Set([focusId]);
  edges.forEach(e=>{if(e.a===focusId)set.add(e.b);if(e.b===focusId)set.add(e.a)});
  return set;
}

function edgeGeom(e){
  const a=nodeMap[e.a],b=nodeMap[e.b];if(!a||!b)return null;
  const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
  const bend=e.curve*38;
  const mx=(a.x+b.x)/2-dy/d*bend, my=(a.y+b.y)/2+dx/d*bend;
  const start=Math.hypot(mx-a.x,my-a.y)||1, end=Math.hypot(mx-b.x,my-b.y)||1;
  const ax=a.x+(mx-a.x)*(a.r+(e.bidirectional?5:3))/start, ay=a.y+(my-a.y)*(a.r+(e.bidirectional?5:3))/start;
  const bx=b.x+(mx-b.x)*(b.r+5)/end, by=b.y+(my-b.y)*(b.r+5)/end;
  return {path:`M${ax},${ay} Q${mx},${my} ${bx},${by}`,
    lx:(ax+2*mx+bx)/4,ly:(ay+2*my+by)/4-5};
}

function renderGraph(){
  if(!W){const r=$('#graphWrap').getBoundingClientRect();W=r.width;H=r.height;svg.setAttribute('viewBox',`0 0 ${W} ${H}`)}
  const fset=focusSet();
  let s='';
  edges.forEach((e,i)=>{
    const gm=edgeGeom(e);if(!gm)return;
    const connectionName=e.product?`${P[e.a].name} ${e.bidirectional?'↔':'→'} ${P[e.b].name} · ${e.label}`:e.label||e.data.label;
    const col=e.kind==='exist'?'#0d9488':'#2563eb';
    const dash=e.kind==='planning'?'stroke-dasharray="6 5"':'';
    const end=`marker-end="url(#ar-${e.forwardKind||e.kind})"`;
    const begin=e.bidirectional?`marker-start="url(#ar-${e.reverseKind})"`:'';
    const selected=focusEdge===i;
    const dim=(focusEdge!==null?!selected:fset&&!(fset.has(e.a)&&fset.has(e.b)))?' dim':'';
    s+=`<path d="${gm.path}" fill="none" stroke="${col}" stroke-width="${selected?4:2}" opacity="${selected?1:.75}" ${dash} ${begin} ${end} class="edge${dim}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(connectionName)}" style="cursor:pointer"><title>${esc(e.product?e.label:e.data.label)}</title></path>`;
    if(e.label){
      s+=`<text x="${gm.lx}" y="${gm.ly}" class="edge-lbl${dim}" fill="${col}" opacity="${selected||e.ref||(e.product&&(focusId===e.a||focusId===e.b))?1:0}" data-i="${i}">${esc(selected?e.label:e.label.length>14?e.label.slice(0,14)+'…':e.label)}</text>`}
  });
  nodes.forEach(n=>{
    const fs=n.sub.length>6?8.5:9.5;
    const dim=fset&&!fset.has(n.id)?' dim':'';
    const cls=['node',n.external?'ext':'',focusId===n.id?'focused':''].filter(Boolean).join(' ');
    s+=`<g class="${cls}${dim}" data-id="${n.id}" transform="translate(${n.x},${n.y})" style="cursor:pointer">
      <g class="node-core">
        <circle cx="0" cy="0" r="${n.r+5}" fill="${n.color}" opacity=".12"/>
        <circle class="core" cx="0" cy="0" r="${n.r}" fill="${n.color}" stroke="#fff" stroke-width="2.5"/>
        <text x="0" y="3.5" class="node-label" style="font-size:${n.label.length>3?9:11}px">${n.label}</text>
        ${n.external?`<text x="0" y="${-n.r-6}" class="ext-tag">↗${esc(P[n.prod].short)}</text>`:''}
        <text x="0" y="${n.r+13}" class="node-sub" style="font-size:${fs}px">${esc(n.sub)}</text>
      </g></g>`;
  });
  const defs=`<defs>
    <marker id="ar-exist" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto-start-reverse"><path d="M0,0 L8,3 L0,6 Z" fill="#0d9488"/></marker>
    <marker id="ar-planning" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto-start-reverse"><path d="M0,0 L8,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>`;
  svg.innerHTML=defs+`<g class="vp" transform="translate(${tx},${ty}) scale(${scale})">${s}</g>`;
  bindGraph();
}

// 拖拽时只更新被拖节点与相连边，避免整图重绘打断动画
function refreshDrag(n){
  const g=svg.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`);
  if(g)g.setAttribute('transform',`translate(${n.x},${n.y})`);
  edges.forEach((e,i)=>{
    if(e.a!==n.id&&e.b!==n.id)return;
    const gm=edgeGeom(e);if(!gm)return;
    const p=svg.querySelector(`.edge[data-i="${i}"]`);if(p)p.setAttribute('d',gm.path);
    const t=svg.querySelector(`.edge-lbl[data-i="${i}"]`);if(t){t.setAttribute('x',gm.lx);t.setAttribute('y',gm.ly)}
  });
}

function bindGraph(){
  $$('#graph .node').forEach(g=>{
    let clickTimer=null,dragMoved=false;
    g.onclick=e=>{
      e.stopPropagation();
      if(dragMoved){dragMoved=false;return}
      if(clickTimer)clearTimeout(clickTimer);
      const id=g.dataset.id;
      clickTimer=setTimeout(()=>{clickTimer=null;focusEdge=null;focusId=id;renderGraph();openNode(id)},230);
    };
    g.ondblclick=e=>{e.stopPropagation();if(clickTimer){clearTimeout(clickTimer);clickTimer=null}drillDown(g.dataset.id)};
    g.addEventListener('mousedown',e=>{
      if(e.button!==0)return;
      e.preventDefault();e.stopPropagation();const n=nodeMap[g.dataset.id];if(!n)return;
      dragMoved=false;g.classList.add('dragging');
      const mv=ev=>{dragMoved=true;const r=svg.getBoundingClientRect();
        n.x=(ev.clientX-r.left-tx)/scale;n.y=(ev.clientY-r.top-ty)/scale;refreshDrag(n);};
      const up=()=>{
        window.removeEventListener('mousemove',mv);window.removeEventListener('mouseup',up);
        g.classList.remove('dragging');g.classList.add('rebound');
        setTimeout(()=>g.classList.remove('rebound'),560);
      };
      window.addEventListener('mousemove',mv);window.addEventListener('mouseup',up);
    });
  });
  $$('#graph .edge').forEach(path=>{
    const index=Number(path.dataset.i);
    const edge=edges[index];
    path.onclick=event=>{
      event.stopPropagation();
      focusId=null;
      focusEdge=index;
      renderGraph();
      if(edge.product)openProductRelation(edge);
      else openEdge(edge.data,edge.kind,edge.ref);
      if(event.type==='keydown')svg.querySelector(`.edge[data-i="${index}"]`)?.focus();
    };
    path.onkeydown=event=>{
      if(event.key==='Enter'||event.key===' '){event.preventDefault();path.onclick(event)}
    };
    if(!edge.ref&&focusEdge!==index&&focusId!==edge.a&&focusId!==edge.b){
      const label=svg.querySelector(`.edge-lbl[data-i="${index}"]`);
      path.onmouseenter=()=>label?.setAttribute('opacity','1');
      path.onmouseleave=()=>label?.setAttribute('opacity','0');
      path.onfocus=path.onmouseenter;
      path.onblur=path.onmouseleave;
    }
  });
}
function goToModule(code,mid){
  if(curView!=='graph')switchView('graph');
  if(sharedProducts.has(code)){
    code=code==='bd'||organizationModels.has(mid)?'shared-data':'shared-system';
  }
  if(dim===(mid?'function':'module')&&productScope===code&&(!mid||$('#scopeSel').value===mid))return;
  graphHistory.push(currentGraphLocation());
  graphBack.disabled=false;
  productScope=code;
  if(mid)rememberedModules.set(code,mid);
  setDim(mid?'function':'module');
}
// 双击下钻：产品→模块；模块→功能；功能→详情；外部节点→跳转到对方产品对应层级
function drillDown(id){
  const n=nodeMap[id];if(!n)return;
  $('#drawer').classList.remove('open');
  if(n.type==='product')goToModule(n.data.code);                       // 产品 → 模块维度
  else if(n.type==='module'&&!n.external)goToModule(n.data.code,n.data.id); // 本模块 → 功能维度（下一级）
  else if(n.type==='function'&&!n.external)openFeature(n.data,n.prod,n.mod); // 本模块内功能 → 功能详情（下一级）
  else if(n.external){
    // 外部关联关系（其他模块/产品）→ 进入该模块视图，而非进入单个功能详情
    goToModule(n.prod,n.modId);
  }
}
function resizeGraph(){const r=$('#graphWrap').getBoundingClientRect();W=r.width;H=r.height;svg.setAttribute('viewBox',`0 0 ${W} ${H}`);renderGraph()}
function rebuild(){buildGraphData();layout();renderGraph();}
function applyTransform(){const vp=svg.querySelector('.vp');if(vp)vp.setAttribute('transform',`translate(${tx},${ty}) scale(${scale})`)}
$('#zin').onclick=()=>{scale=Math.min(2.5,scale*1.15);applyTransform()};
$('#zout').onclick=()=>{scale=Math.max(.4,scale/1.15);applyTransform()};
$('#zreset').onclick=()=>{scale=1;tx=0;ty=0;applyTransform()};
svg.addEventListener('wheel',e=>{e.preventDefault();scale=Math.max(.4,Math.min(2.5,scale*(e.deltaY<0?1.1:.9)));applyTransform()},{passive:false});
let panning=false,px=0,py=0;
svg.addEventListener('mousedown',e=>{if(e.target.closest('.node')||e.target.closest('.edge'))return;panning=true;px=e.clientX;py=e.clientY;svg.classList.add('grabbing')});
svg.addEventListener('click',e=>{if(e.target.closest('.node')||e.target.closest('.edge'))return;if(focusId||focusEdge!==null){focusId=null;focusEdge=null;renderGraph()}});
window.addEventListener('mousemove',e=>{if(!panning)return;tx+=e.clientX-px;ty+=e.clientY-py;px=e.clientX;py=e.clientY;applyTransform()});
window.addEventListener('mouseup',()=>{panning=false;svg.classList.remove('grabbing')});
$('#tgExist').onchange=rebuild;
$('#tgPlanning').onchange=rebuild;
$('#tgProjected').onchange=rebuild;

/* dimension + scope */
$$('#sharedFoundation [data-shared-scope]').forEach(button=>{
  button.onclick=()=>goToModule(button.dataset.sharedScope);
});
$$('#dimSeg button').forEach(b=>b.onclick=()=>setDim(b.dataset.dim));
function setDim(d){
  dim=d;
  $('#sharedFoundation').hidden=d!=='product';
  $('#projectedOption').hidden=d==='product';
  $$('#dimSeg button').forEach(b=>b.classList.toggle('active',b.dataset.dim===d));
  const scopeLbl=$('#scopeLbl'),scopeSel=$('#scopeSel');
  $('#scopeName').textContent=d==='module'?'范围':'业务模型';
  if(d==='product'){scopeLbl.style.display='none'}
  else if(d==='module'){
    scopeLbl.style.display='flex';
    scopeSel.innerHTML=businessProducts.map(p=>`<option value="${p.code}">${esc(p.name)}</option>`).join('')+
      `<optgroup label="全产品共用">${Object.entries(sharedScopes).map(([key,value])=>
        `<option value="${key}">${esc(value.label)}</option>`).join('')}</optgroup>`;
    scopeSel.value=productScope;
  } else {
    scopeLbl.style.display='flex';
    const code=productScope;
    const ms=modelsInScope(code);
    const hasOverview=['batchref','processref'].includes(code)&&ms.length;
    scopeSel.innerHTML=(hasOverview?`<option value="${allModels}">全部业务模型</option>`:'')+
      ms.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('');
    const remembered=rememberedModules.get(code);
    if((hasOverview&&remembered===allModels)||ms.some(m=>m.id===remembered))scopeSel.value=remembered;
  }
  updateScopePath();
  scale=1;tx=0;ty=0;
  if(curView==='graph'){resizeGraph();rebuild()}
}
function updateScopePath(){
  const model=dim==='function'?(MOD_BY_ID[$('#scopeSel').value]?.name||'全部业务模型'):'';
  $('#graphScopePath').textContent=dim==='product'?'':[`${sharedScopes[productScope]?'全产品共用':'产品'}：${scopeName(productScope)}`,model&&`模型：${model}`].filter(Boolean).join(' / ');
}
$('#scopeSel').onchange=()=>{
  if(dim==='module')productScope=$('#scopeSel').value;
  if(dim==='function')rememberedModules.set(productScope,$('#scopeSel').value);
  updateScopePath();
  scale=1;tx=0;ty=0;rebuild();
};

/* graph node click dispatch */
function openNode(id){
  const n=nodeMap[id];if(!n)return;
  if(n.type==='product') openProduct(n.data.code);
  else if(n.type==='module'||n.type==='extmodule') openModule(n.data);
  else if(n.type==='function'||n.type==='extfunction') openFeature(n.data,n.prod,n.mod);
}

/* ---------- drawer ---------- */
let drTab='overview', drCtx=null;
function openDrawer(badge,color,title,sub,tabs,ctx){
  $('#drBadge').textContent=badge;$('#drBadge').style.background=color;
  $('#drTitle').textContent=title;$('#drSub').textContent=sub;
  drCtx=ctx;drTab=(tabs&&tabs.length)?tabs[0].key:'';
  $('#drTabs').innerHTML=(tabs||[]).map(t=>`<div class="dr-tab ${t.key===drTab?'active':''}" data-k="${t.key}">${t.label}</div>`).join('');
  $$('#drTabs .dr-tab').forEach(el=>el.onclick=()=>{drTab=el.dataset.k;
    $$('#drTabs .dr-tab').forEach(x=>x.classList.toggle('active',x.dataset.k===drTab));renderDrawerBody()});
  renderDrawerBody();
  $('#drawer').classList.add('open');
}
$('#drClose').onclick=()=>$('#drawer').classList.remove('open');
function renderDrawerBody(){ if(drCtx&&drCtx[drTab]) $('#drBody').innerHTML=drCtx[drTab](); }
$('#drBody').onclick=event=>{
  const target=event.target.closest('[data-mod],[data-fid],[data-if],[data-product-ref],[data-locate-feature],[data-index-feature],[data-graph-relation],[data-audit-issue],[data-copy-feature],[data-edit-interface],[data-trace-feature],[data-audit-interface],[data-audit-model]');
  if(!target)return;
  const {mod,fid,if:interfaceId,productRef,refIndex,locateFeature,indexFeature,graphRelation,relationLevel,auditScope,auditIssue,copyFeature,editInterface,traceFeature:traceId,auditInterface,auditModel}=target.dataset;
  if(auditInterface){
    $('#drawer').classList.remove('open');
    ifTerm='';ifType='';ifStat='';ifAudit=auditInterface;
    $('#ifSearch').value='';$('#ifType').value='';$('#ifStatus').value='';$('#ifAudit').value=ifAudit;
    switchView('interface');
    return;
  }
  if(auditModel){
    const model=MOD_BY_ID[auditModel];
    if(model)openModule(model,'refs');
    return;
  }
  if(traceId){
    const feature=FEAT_BY_ID[traceId];
    if(feature){
      $('#drawer').classList.remove('open');
      switchView('trace');
      traceFeature(feature.code,feature.id);
    }
    return;
  }
  if(editInterface){
    const entry=ifaces.find(item=>item.id===editInterface);
    if(entry)showModal(entry);
    return;
  }
  if(copyFeature){
    const input=$('#featureLink');
    const status=$('#featureLinkStatus');
    if(!input||!status)return;
    input.focus();
    input.select();
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(input.value).then(
        ()=>{status.textContent='已复制功能链接。';},
        ()=>{status.textContent='已选中链接，可手动复制。';}
      );
    }else{
      status.textContent='已选中链接，可手动复制。';
    }
    return;
  }
  if(auditIssue){
    openFunctionIndex({scope:auditScope,issue:auditIssue});
    return;
  }
  if(graphRelation){
    const rows=relationLevel==='module'?G.moduleRefs:G.featureRefs;
    const relation=rows.find(row=>row.id===graphRelation);
    if(relation)openEdge(relation,linkKind(relation),true);
    return;
  }
  if(locateFeature||indexFeature){
    const feature=FEAT_BY_ID[locateFeature||indexFeature];
    if(!feature)return;
    locateFeatureNode(feature,{details:Boolean(indexFeature)});
    return;
  }
  if(productRef){
    const refs=G.productLinks.filter(e=>e.source===productRef||e.target===productRef);
    const edge=refs[Number(refIndex)];
    if(edge)openEdge(edge,linkKind(edge),false);
    return;
  }
  if(interfaceId){openIface(interfaceId);return}
  if(mod){
    const model=MOD_BY_ID[mod];
    if(model)goToModule(model.code,model.id);
    return;
  }
  const feature=FEAT_BY_ID[fid];
  if(feature)openFeature(feature,feature.code,feature.modName);
};

function linkRowsHtml(arr,dir,type){
  return arr.map(e=>{const other=P[dir==='in'?e.source:e.target];
    return `<div class="link-row ${type}"><div class="dir">${dir==='in'?'◀ 上游输入':'下游输出 ▶'} · ${other.abbr} ${other.name}</div><div class="txt">${esc(e.label)}</div></div>`}).join('');
}
function openProduct(code){
  const p=P[code],mods=MODULES.filter(m=>m.code===code);
  const exIn=G.existingLinks.filter(e=>e.target===code),exOut=G.existingLinks.filter(e=>e.source===code);
  const sgIn=G.suggestedLinks.filter(e=>e.target===code),sgOut=G.suggestedLinks.filter(e=>e.source===code);
  const pif=ifaces.filter(f=>f.from===code||f.to===code);
  const references=G.productLinks.filter(e=>e.source===code||e.target===code);
  const tabs=[
    {key:'overview',label:'概览'},
    {key:'modules',label:`业务模型 ${mods.length}`},
    {key:'links',label:`联动 ${exIn.length+exOut.length+sgIn.length+sgOut.length+references.length}`},
    {key:'ifaces',label:`接口 ${pif.length}`},
  ];
  const ctx={
    overview:()=>`
      <div class="sec"><h5>定位</h5><p>${esc(p.overview||p.purpose)}</p></div>
      <div class="sec"><h5>适用对象</h5><p>${esc(p.audience||'—')}</p></div>`,
    modules:()=>`<div class="sec"><h5>功能模块（${mods.length}），点击下钻</h5><div>${mods.map(m=>`<span class="mod-chip" data-mod="${m.id}">${esc(m.name)} <b style="color:var(--sub)">${m.features.length}</b></span>`).join('')}</div></div>`,
    links:()=>[
      ['现有','exist',exIn,exOut],['规划','planning',sgIn,sgOut],
    ].map(([title,kind,incoming,outgoing])=>{
      const rows=linkRowsHtml(incoming,'in',kind==='exist'?'exist':'sugg')+
        linkRowsHtml(outgoing,'out',kind==='exist'?'exist':'sugg')+
        references.map((e,i)=>linkKind(e)===kind?`
          <button type="button" class="icon-btn" data-product-ref="${esc(code)}" data-ref-index="${i}">
            ${esc(P[e.source].name)} → ${esc(P[e.target].name)} · ${e.scenarios.length} 个场景
          </button>`:'').join('');
      return `<div class="sec"><h5>${title}</h5>${rows||'<p>—</p>'}</div>`;
    }).join(''),
    ifaces:()=>`<div class="sec"><h5>接口（${pif.length}）</h5>${pif.map(f=>`<div class="link-row ${f.type==='MOM建议'?'sugg':'exist'}" data-if="${f.id}" style="cursor:pointer"><div class="dir">${esc(f.id)} · ${esc(f.type)} · ${esc(f.status)}</div><div class="txt">${esc(f.name)}<br>${esc(f.remark)}</div></div>`).join('')||'<p>暂无接口，可在接口管理中新增</p>'}</div>`,
  };
  openDrawer(p.abbr,p.color,p.name,'',tabs,ctx);
}
function scenarioMarkup(scenario){
  return `<p>${esc(scenario.summary)}</p>${scenario.groups.map(group=>`
    <div class="sec"><h5>${esc(group.name)}</h5>${group.pairs.map(([source,target])=>{
      const relation=G.featureRefs.find(r=>r.sourceFeature===source&&r.targetFeature===target&&!isProjected(r));
      if(!relation)return '<p>该步骤的关系依据待补充。</p>';
      const from=FEAT_BY_ID[source],to=FEAT_BY_ID[target];
      const present=linkKind(relation)==='exist';
      return `<div class="link-row ${present?'exist':'sugg'}">
        <div class="dir">${present?'现有':'规划'} · ${esc(relation.reference?evidenceName(relation):'功能说明')}</div>
        <div class="txt"><strong>${esc(from.name)} → ${esc(to.name)}</strong><br>${esc(relation.scene||relation.label)}</div>
        <button class="icon-btn" type="button" data-graph-relation="${esc(relation.id)}" data-relation-level="feature">查看关系依据</button>
        <button class="icon-btn" type="button" data-locate-feature="${esc(source)}">定位起点</button>
        <button class="icon-btn" type="button" data-locate-feature="${esc(target)}">定位终点</button>
      </div>`;
    }).join('')}</div>`).join('')}`;
}

$('#graphScenarios').onclick=()=>{
  const tabs=workflowScenarios.map((s,i)=>({key:`scenario-${i}`,label:s.title}));
  const ctx=Object.fromEntries(workflowScenarios.map((scenario,i)=>[`scenario-${i}`,()=>scenarioMarkup(scenario)]));
  openDrawer('业务场景','#2563eb','场景链路','选择场景查看依据与相关功能',tabs,ctx);
};

const functionIndex = Object.values(FEAT_BY_ID).map(feature=>{
  const refs=G.featureRefs.filter(r=>r.sourceFeature===feature.id||r.targetFeature===feature.id);
  const reviews=refs.map(projectionReview).filter(Boolean);
  return {feature, visible:refs.length-reviews.length,
    projected:reviews.filter(r=>!r.rejected).length, rejected:reviews.filter(r=>r.rejected).length};
});
const functionIssueFilters={
  all:()=>true,
  missing:row=>!row.feature.desc?.trim(),
  linked:row=>row.visible>0,
  unlinked:row=>!row.visible&&!row.projected&&!row.rejected,
  projected:row=>row.projected>0,
  projectedOnly:row=>!row.visible&&row.projected>0,
  rejected:row=>row.rejected>0,
};

function openFunctionIndex({scope='',issue='all'}={}){

  openDrawer('知识图谱','#2563eb','查找功能','按名称、编号、产品或业务模型查询',
    [{key:'index',label:'功能索引'}],{index:()=>`
      <div class="function-index-controls">
        <label for="featureSearch">关键词</label>
        <input id="featureSearch" type="search" placeholder="例如 排班、维修工单、eam-M6-F8">
        <label for="featureProduct">产品范围</label>
        <select id="featureProduct"><option value="">全部产品</option>${G.products.map(p=>
          `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('')}</select>
        <label for="featureEvidence">资料范围</label>
        <select id="featureEvidence">
          <option value="all">全部功能</option>
          <option value="missing">缺少功能说明</option>
          <option value="linked">有可直接查看的关系</option>
          <option value="unlinked">暂无已登记关系</option>
          <option value="projected">有待核验映射</option>
          <option value="projectedOnly">只有待核验映射</option>
          <option value="rejected">有端点不匹配</option>
        </select>
      </div>
      <p id="featureSearchCount" role="status"></p>
      <div id="featureSearchResults" class="function-index-list"></div>`});
  const input=$('#featureSearch');
  const filter=$('#featureEvidence');
  const product=$('#featureProduct');
  product.value=scope;
  filter.value=issue;
  const render=()=>{
    const terms=input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches=functionIndex.filter(row=>{
      const f=row.feature;
      const searchable=[f.name,f.id,f.modName,scopeName(f.code)].join(' ').toLowerCase();
      return (!product.value||f.code===product.value)&&terms.every(term=>searchable.includes(term))&&
        functionIssueFilters[filter.value](row);
    });
    $('#featureSearchCount').textContent=`${matches.length} 个功能`;
    $('#featureSearchResults').innerHTML=matches.map(({feature:f,visible,projected,rejected})=>`
      <button class="icon-btn" type="button" data-index-feature="${esc(f.id)}">
        ${esc(f.name)}
        <small>${esc(scopeName(f.code))} / ${esc(f.modName)} · ${esc(f.id)}</small>
        <small>${f.desc?.trim()?'有功能说明':'缺少功能说明'} · ${visible} 条已登记关系 · ${projected} 条待核验映射${rejected?` · ${rejected} 条端点不匹配`:''}</small>
      </button>`).join('');
  };
  input.oninput=render;
  filter.onchange=render;
  product.onchange=render;
  render();
  input.focus();
}
$('#graphFind').onclick=()=>openFunctionIndex();

$('#graphAudit').onclick=()=>{
  const issues=[['missing','缺少功能说明'],['unlinked','暂无关系'],['projectedOnly','只有待核验映射'],['rejected','端点不匹配']];
  const productRows=G.products.map(p=>{
    const rows=functionIndex.filter(row=>row.feature.code===p.code);
    return `<div class="link-row">
      <div class="txt"><strong>${esc(p.name)}</strong> · ${rows.length} 个功能</div>
      ${issues.map(([key,label])=>{
        const n=rows.filter(functionIssueFilters[key]).length;
        return `<button class="icon-btn" type="button" data-audit-scope="${esc(p.code)}" data-audit-issue="${key}" ${n?'':'disabled'}>${label} ${n}</button>`;
      }).join('')}
    </div>`;
  });
  const pairs=groupedProductEdges(currentLinks({applyFilters:false}));
  const documented=G.existingLinks.map(r=>projectedInterfaceByRelation.get(productRelationKey(r.source,r.target,r.label)))
    .map(r=>productSourceReview(r?.interfaceId)).filter(Boolean);
  const modelCounts=new Map(MODULES.map(model=>[model.id,{model,existing:0,planning:0,projected:0,rejected:0}]));
  for(const ref of G.moduleRefs){
    const review=projectionReview(ref);
    const kind=review?(review.rejected?'rejected':'projected'):linkKind(ref)==='exist'?'existing':'planning';
    for(const id of new Set([ref.sourceModule,ref.targetModule]))modelCounts.get(id)[kind]++;
  }
  const totals=G.moduleRefs.map(ref=>({review:projectionReview(ref),kind:linkKind(ref)}));
  const modelRows=[...modelCounts.values()].sort((a,b)=>(b.projected+b.rejected)-(a.projected+a.rejected));
  openDrawer('工程核查','#2563eb','图谱核查总览','按层级查看来源、缺口和对应节点',
    [{key:'audit',label:'功能缺口'},{key:'products',label:'产品关系'},{key:'models',label:'模型关系'}],{
      audit:()=>`
        <p>同一功能可能同时缺少说明和关系。暂无关系表示图谱还没有登记上下游，是否独立需结合业务资料判断。</p>
        ${productRows.join('')}`,
      products:()=>`
        <div class="sec"><h5>业务产品图</h5><p>${businessProducts.length} 个业务产品 · ${pairs.length} 对产品关系 · ${pairs.filter(e=>e.bidirectional).length} 对双向关系</p>
        <p>按两个联动类型均启用计算。公共能力在专属入口查看。</p></div>
        <div class="sec"><h5>历史关系的手册核查</h5><p>${documented.filter(r=>r.supported).length} 条有产品层资料，${documented.filter(r=>!r.supported).length} 条方向缺少直接依据。</p>
        <button class="icon-btn" type="button" data-audit-interface="productDirection">查看方向缺少依据的接口</button></div>`,
      models:()=>`
        <p>${G.modules.length} 个模型 · ${totals.filter(r=>!r.review&&r.kind==='exist').length} 条现有 ·
          ${totals.filter(r=>!r.review&&r.kind==='planning').length} 条规划 ·
          ${totals.filter(r=>r.review&&!r.review.rejected).length} 条待核验映射 ·
          ${totals.filter(r=>r.review?.rejected).length} 条历史端点不匹配</p>
        <p>每条关系在汇总中计一次，涉及两个模型时会在两侧模型详情中显示。</p>
        <div class="function-index-list">${modelRows.map(({model:m,existing,planning,projected,rejected})=>
          `<button class="icon-btn" type="button" data-audit-model="${esc(m.id)}">${esc(scopeName(m.code))} / ${esc(m.name)}
            <small>现有 ${existing} · 规划 ${planning} · 待核验 ${projected} · 端点不匹配 ${rejected}</small>
          </button>`).join('')}</div>`,
    });

};

function openModule(m,initialTab){
  const p=P[m.code];
  const mrefs=G.moduleRefs.filter(r=>r.sourceModule===m.id||r.targetModule===m.id);
  const tabs=[{key:'overview',label:'概览'},{key:'funcs',label:`功能点 ${m.features.length}`},
    {key:'refs',label:`业务关系 ${mrefs.length}`}];
  const ctx={
    overview:()=>`<div class="dim-note">${p.name}（${p.abbr}）· ${m.id}</div><div class="sec"><h5>${m.evidence==='planning'?'规划参考图':'业务模型'}</h5><p>${esc(m.desc||m.name)}</p></div>`,
    funcs:()=>`<div class="sec"><h5>功能点（${m.features.length}），点击查看说明</h5><div>${m.features.map(f=>`<span class="mod-chip" data-fid="${f.id}">${esc(f.name)}</span>`).join('')}</div></div>`,
    refs:()=>`<div class="dim-note">关系明细包含业务场景及资料依据。</div>
      <div class="sec"><h5>模块业务关系（${mrefs.length}）</h5>${relationSections(mrefs,m.id,'module')}</div>`,
  };
  openDrawer('模块',p.color,m.name,`${p.name} / 模块`,tabs,ctx);
  if(initialTab)$('#drTabs [data-k="refs"]').click();
}
function featureUrl(id){
  const url=new URL(location.href);
  url.searchParams.set('feature',id);
  url.hash='';
  return url.href;
}

function locateFeatureNode(feature,{details=false}={}){
  $('#drawer').classList.remove('open');
  goToModule(feature.code,feature.modId);
  focusId=feature.id;
  renderGraph();
  if(details)openFeature(feature,feature.code,feature.modName);
}

function openFeature(f,code,mod){
  const p=P[code];
  const frefs=G.featureRefs.filter(r=>r.sourceFeature===f.id||r.targetFeature===f.id);
  openDrawer('功能点',p.color,f.name,`${p.name} / ${mod}`,
    [{key:'overview',label:'说明'},{key:'refs',label:`业务关系 ${frefs.length}`}],
    {overview:()=>`<div class="sec feature-share">
      <label for="featureLink">功能定位链接 · ${esc(f.id)}</label>
      <div><input id="featureLink" type="url" readonly value="${esc(featureUrl(f.id))}">
        <button class="icon-btn" type="button" data-copy-feature="${esc(f.id)}">复制</button></div>
      <span id="featureLinkStatus" role="status"></span>
      <button class="icon-btn" type="button" data-trace-feature="${esc(f.id)}">追溯上下游</button>
    </div>
    <div class="sec"><h5>${f.reference?evidenceName(f):'功能说明'}</h5><p>${esc(f.desc||'资料尚未提供足以核验的功能说明。')}</p></div>
      ${f.descriptionBasis?`<div class="sec"><h5>说明依据</h5><p>${esc(f.descriptionBasis)}</p></div>`:''}
      ${f.manualEvidence?.length?`<div class="sec"><h5>补充手册同名章节</h5>
        <p>按业务域和章节名称匹配，功能版本与实际配置待核验。</p>
        ${f.manualEvidence.map(item=>`<p>${esc(item.chapter)} · ${esc(item.source)} · ${esc(item.locatorType)} ${esc(item.locator)}</p>`).join('')}</div>`:''}
      <div class="sec"><h5>所属</h5><div class="kv"><span class="k">产品</span><span class="v">${p.name}（${p.abbr}）</span></div><div class="kv"><span class="k">模块</span><span class="v">${esc(mod)}</span></div><div class="kv"><span class="k">编号</span><span class="v">${f.id}</span></div></div>`,
     refs:()=>`<div class="dim-note">关系明细包含业务场景及资料依据。</div>
      <div class="sec"><h5>功能业务关系（${frefs.length}）</h5>${relationSections(frefs,f.id,'feature')}</div>`});
}
function openEdge(e,kind,isRef){
  if(!e)return;
  const review=isRef?projectionReview(e):null;
  const ist=kind==='exist';
  const s=P[e.source],t=P[e.target];
  const sm=isRef?MOD_BY_ID[e.sourceModule]:null, tm=isRef?MOD_BY_ID[e.targetModule]:null;
  const sf=isRef&&e.sourceFeature?FEAT_BY_ID[e.sourceFeature]:null;
  const tf=isRef&&e.targetFeature?FEAT_BY_ID[e.targetFeature]:null;
  const srcPath=`${s.abbr}${sm?' / '+sm.name:''}${sf?' / '+sf.name:''}`;
  const tgtPath=`${t.abbr}${tm?' / '+tm.name:''}${tf?' / '+tf.name:''}`;
  const sharedDependency=isRef&&(sharedProducts.has(e.source)!==sharedProducts.has(e.target));
  const level=sharedDependency?'公共能力依赖':isRef?(sf||tf?'功能级关系':'模型级关系'):e.reference?'产品级关系':'产品级联动';
  const flow=`<div class="rel-flow">
    <div class="rel-node ${ist?'exist':'sugg'}"><span class="rel-role">关系起点</span><b>${esc(srcPath)}</b></div>
    <div class="rel-arrow ${ist?'':'sugg'}">${e.reference?'资料所述流向 ▶':ist?'现有交互 ▶':'建议 ⇢'}</div>
    <div class="rel-node ${ist?'exist':'sugg'}"><span class="rel-role">关系终点</span><b>${esc(tgtPath)}</b></div>
  </div>`;
  const extra=e.internal||e.reference
    ?`<div class="sec"><h5>资料依据</h5><p>${esc(e.basis)}</p></div>`
    :isRef
    ?`<div class="sec"><h5>推导依据</h5><p>${esc(e.basis)}</p></div>
      <div class="dim-note">${level}由产品级联动向下投影推导，非手册原文；具体接口字段请在「接口管理」中补充。</div>
      <div class="link-row ${ist?'exist':'sugg'}" data-if="${esc(e.interfaceId)}" style="cursor:pointer"><div class="dir">关联接口 ${esc(e.interfaceId)}</div><div class="txt">点击查看 / 编辑接口明细</div></div>`
    :ist?`<div class="sec"><h5>联动类型</h5><p style="color:var(--exist);font-weight:600">现有功能联动 · ${esc(e.aspect)}</p></div>`
        :`<div class="sec"><h5>MOM 概念</h5><p style="color:var(--sugg);font-weight:600">${esc(e.momConcept)}</p></div><div class="sec"><h5>建议依据</h5><p>${esc(e.rationale)}</p></div>`;
  const destinations=(review?.rejected?[]:[sf,tf]).filter(Boolean).map(feature=>
    `<button class="icon-btn" type="button" data-locate-feature="${esc(feature.id)}">定位 ${esc(feature.name)}</button>`).join('');
  const body=`${review?`<div class="dim-note"><strong>${esc(review.label)}</strong><p>${esc(review.reason)}</p></div>`:''}${flow}${destinations?`<div class="sec"><h5>图谱位置</h5>${destinations}</div>`:''}${e.scenarios ? e.scenarios.map(item=>`
    <div class="sec"><h5>${esc(item.scene)}</h5><p>${esc(item.label)}</p><p>${esc(item.basis)}</p></div>`).join('')
    : `<div class="sec"><h5>${level} · ${esc(e.scene||'业务交互内容')}</h5><p>${esc(e.label)}</p></div>${extra}`}`;

  openDrawer(review?.label||(ist?'现有':'规划'),
    ist?'#0d9488':'#2563eb',isRef?`${s.abbr} ⇢ ${t.abbr}`:`${s.abbr} → ${t.abbr}`,
    `${level} · ${e.reference?evidenceName(e):e.internal?'依据功能说明':ist?(isRef?'由产品联动推导':'手册明确记载'):(isRef?'行业概念推导（非手册原文）':'行业概念建议（非现有功能）')}`,
    [{key:'d',label:'关联关系'}],{d:()=>body});
}

function relationSections(relations,localId,level){
  if(!relations.length)return '<p>暂无已登记关系。</p>';
  const endpoint=level==='module'?'Module':'Feature';
  return [
    ['上游来源',relations.filter(r=>r['target'+endpoint]===localId)],
    ['下游用途',relations.filter(r=>r['source'+endpoint]===localId)],
  ].filter(([,rows])=>rows.length).map(([title,rows])=>
    `<div class="sec"><h5>${title}（${rows.length}）</h5>${rows.map(r=>refRowHtml(r,localId,level)).join('')}</div>`).join('');
}

function refRowHtml(r,localId,level){
  const isOut=level==='module'?r.sourceModule===localId:r.sourceFeature===localId;
  const other=P[isOut?r.target:r.source];
  const otherModel=MOD_BY_ID[isOut?r.targetModule:r.sourceModule];
  const otherFeature=level==='feature'?FEAT_BY_ID[isOut?r.targetFeature:r.sourceFeature]:null;
  const name=[other.name,otherModel?.name,otherFeature?.name].filter(Boolean).join(' / ');
  const current=linkKind(r)==='exist';
  const review=projectionReview(r);
  const evidence=review?.label||(r.reference?evidenceName(r):'功能说明');
  return `<div class="link-row ${current?'exist':'sugg'}">
    <div class="dir">${review?'历史映射':current?'现有':'规划'} · ${esc(evidence)}</div>
    <div class="txt"><strong>${esc(name)}</strong><br>${esc(r.scene||r.label)}</div>
    <button class="icon-btn" type="button" data-graph-relation="${esc(r.id)}" data-relation-level="${level}">查看关系依据</button>
    ${otherFeature&&!review?.rejected?`<button class="icon-btn" type="button" data-locate-feature="${esc(otherFeature.id)}">定位对端</button>`:''}
    ${r.interfaceId?`<button class="icon-btn" type="button" data-if="${esc(r.interfaceId)}">查看接口 ${esc(r.interfaceId)}</button>`:''}
  </div>`;
}

const traceFeature=bindTrace(request,esc,G,id=>{
  const feature=FEAT_BY_ID[id];
  if(feature)locateFeatureNode(feature,{details:true});
});

/* ---------- interface manager ---------- */
let ifTerm='',ifType='',ifStat='',ifAudit='';
const mappingByInterface=new Map(G.featureRefs.filter(isProjected).map(ref=>[ref.interfaceId,ref]));
const interfaceDetailFields=[
  ['fromFeature','源功能'],['toFeature','目标功能'],['trigger','触发条件'],
  ['protocol','协议'],['dataItems','数据项'],['frequency','频率'],['owner','负责人'],
];
function interfaceAudit(entry){
  const mapping=mappingByInterface.get(entry.id);
  return {
    direction:Boolean(mapping&&(entry.from!==mapping.source||entry.to!==mapping.target)),
    review:mapping?projectionReview(mapping):null,
    source:productSourceReview(entry.id),
    gaps:interfaceDetailFields.filter(([key])=>!String(entry[key]||'').trim()).map(([,label])=>label),
  };
}
const interfaceAuditFilters={
  '':()=>true,
  details:a=>a.gaps.length>0,
  pending:a=>a.review&&!a.review.rejected,
  rejected:a=>a.review?.rejected,
  direction:a=>a.direction,
  productDirection:a=>a.source?.supported===false,
};
$('#ifSearch').oninput=e=>{ifTerm=e.target.value.toLowerCase();renderIfaces()};
$('#ifType').onchange=e=>{ifType=e.target.value;renderIfaces()};
$('#ifStatus').onchange=e=>{ifStat=e.target.value;renderIfaces()};
$('#ifAudit').onchange=e=>{ifAudit=e.target.value;renderIfaces()};
function renderIfaces(){
  const rows=ifaces.map(f=>({f,audit:interfaceAudit(f)}));
  const list=rows.filter(({f,audit})=>interfaceAuditFilters[ifAudit](audit)&&(!ifType||f.type===ifType)&&(!ifStat||f.status===ifStat)&&
    (!ifTerm||([f.id,f.name,f.from,f.to,P[f.from]?.name,P[f.to]?.name,f.fromFeature,f.toFeature,f.remark].join(' ').toLowerCase()).includes(ifTerm)));
  $('#ifCount').textContent=`显示 ${list.length} / ${rows.length} 条接口 · 技术明细有空项 ${rows.filter(x=>x.audit.gaps.length).length} 条 · 历史端点不匹配 ${rows.filter(x=>x.audit.review?.rejected).length} 条`;
  if(!list.length){$('#ifList').innerHTML='<div class="empty-state">没有匹配的接口。</div>';return}
  let h='<table class="tif"><thead><tr><th>编号</th><th>接口名称</th><th>方向</th><th>源→目标功能</th><th>类型</th><th>台账状态</th><th>核查</th><th>协议/频率</th><th>操作</th></tr></thead><tbody>';
  list.forEach(({f,audit})=>{
    const stc=f.status==='已完善'?'ok':f.status==='规划待补充'?'plan':'todo';
    h+=`<tr><td>${esc(f.id)}</td><td>${esc(f.name)}</td>
      <td>${esc(P[f.from]?P[f.from].abbr:f.from)} → ${esc(P[f.to]?P[f.to].abbr:f.to)}</td>
      <td>${esc(f.fromFeature||'待补充')} → ${esc(f.toFeature||'待补充')}</td>
      <td><span class="badge2 ${f.type==='MOM建议'?'sugg':'exist'}">${esc(f.type)}</span></td>
      <td><span class="st ${stc}">${esc(f.status)}</span></td>
      <td>${esc([audit.direction?'登记方向有变化':'',audit.source?.supported===false?'产品方向待核验':'',audit.review?.label,audit.gaps.length?`${audit.gaps.length} 项未填`:''].filter(Boolean).join(' · ')||'—')}</td>
      <td>${esc(f.protocol||'—')} / ${esc(f.frequency||'—')}</td>
      <td class="act" data-if="${esc(f.id)}">详情</td></tr>`;
  });
  h+='</tbody></table>';
  $('#ifList').innerHTML=h;
  $$('#ifList [data-if]').forEach(el=>el.onclick=()=>openIface(el.dataset.if));
}
function openIface(id){
  const f=ifaces.find(x=>x.id===id);if(!f)return;
  const {direction,review,source,gaps:outstanding}=interfaceAudit(f);
  const body=`<button class="icon-btn" type="button" data-edit-interface="${esc(f.id)}">编辑接口登记</button>${direction?`<p class="dim-note">当前产品方向和历史映射不同，请核对原场景是否仍适用。</p>`:''}${review?`<div class="dim-note"><strong>图谱映射核查 · ${esc(review.label)}</strong><p>${esc(review.reason)}</p></div>`:''}
    ${source?`<div class="sec"><h5>${source.supported?'产品关系手册依据':'产品方向待核验'}</h5>
      <p>${esc(source.source)}<br>${esc(source.scope)}</p></div>`:''}
    ${outstanding.length?`<div class="sec"><h5>尚未填写的接口明细</h5><p>${esc(outstanding.join('、'))}</p></div>`:''}
    <div class="sec"><h5>接口方向</h5><p><b>${P[f.from]?P[f.from].name:f.from}</b> → <b>${P[f.to]?P[f.to].name:f.to}</b></p></div>
    <div class="sec"><h5>功能间交互</h5><div class="kv"><span class="k">源功能</span><span class="v">${esc(f.fromFeature||'待补充')}</span></div><div class="kv"><span class="k">目标功能</span><span class="v">${esc(f.toFeature||'待补充')}</span></div><div class="kv"><span class="k">交互方向</span><span class="v">${esc(f.direction)}</span></div><div class="kv"><span class="k">触发条件</span><span class="v">${esc(f.trigger||'待补充')}</span></div></div>
    <div class="sec"><h5>技术明细</h5><div class="kv"><span class="k">协议</span><span class="v">${esc(f.protocol||'待补充')}</span></div><div class="kv"><span class="k">数据项</span><span class="v">${esc(f.dataItems||'待补充')}</span></div><div class="kv"><span class="k">频率</span><span class="v">${esc(f.frequency||'待补充')}</span></div><div class="kv"><span class="k">负责人</span><span class="v">${esc(f.owner||'待补充')}</span></div></div>
    <div class="sec"><h5>说明</h5><p>${esc(f.remark)}</p></div>`;
  openDrawer(f.id,f.type==='MOM建议'?'#e08700':'#0d9488',f.name,`${f.type} · ${f.status}`,[{key:'d',label:'接口详情'}],{d:()=>body});
}
// modal edit
let editingId=null;
$('#ifAdd').onclick=()=>{editingId=null;showModal({})};
function showModal(f){
  editingId=f.id||null;
  $('#modalTitle').textContent=f.id?'编辑接口 '+f.id:'新增接口';
  const prods=G.products.map(p=>p.name);
  const fields=[
    ['name','接口名称','text',f.name||''],
    ['from','源产品','select',f.from||G.products[0].code,prods],
    ['to','目标产品','select',f.to||G.products[1].code,prods],
    ['fromFeature','源功能','text',f.fromFeature||''],
    ['toFeature','目标功能','text',f.toFeature||''],
    ['direction','交互方向','select',f.direction||'单向',['单向','双向']],
    ['trigger','触发条件','text',f.trigger||''],
    ['protocol','协议/方式','text',f.protocol||''],
    ['frequency','调用频率','text',f.frequency||''],
    ['dataItems','数据项','textarea',f.dataItems||''],
    ['owner','负责人','text',f.owner||''],
    ['status','状态','select',f.status||'待补充明细',['待补充明细','规划待补充','已完善']],
    ['remark','备注','textarea',f.remark||''],
  ];
  $('#modalForm').innerHTML=fields.map(fd=>{
    const [key,label,type,val,opts]=fd;
    if(type==='select'){
      // 产品下拉：option value=code，text=中文名；其余下拉 value=text
      const isProd = key==='from'||key==='to';
      const options=(opts||[]).map(o=>{
        const v = isProd ? (G.products.find(p=>p.name===o)?.code||o) : o;
        return `<option value="${esc(v)}" ${v===val?'selected':''}>${esc(o)}</option>`;
      }).join('');
      return `<div><label>${label}</label><select name="${key}">${options}</select></div>`}
    if(type==='textarea') return `<div class="full"><label>${label}</label><textarea name="${key}">${esc(val)}</textarea></div>`;
    return `<div><label>${label}</label><input name="${key}" value="${esc(val)}"></div>`;
  }).join('');
  $('#modalMask').classList.add('open');
}
$('#modalCancel').onclick=()=>$('#modalMask').classList.remove('open');
$('#modalSave').onclick = async () => {
  const form = $('#modalForm');
  if (!form.querySelector('[name=name]').value.trim()) { alert('请输入接口名称'); return; }
  const button = $('#modalSave');
  const id = editingId;
  const previous = ifaces.find(row => row.id === id);
  const row = Object.fromEntries([...form.querySelectorAll('[name]')].map(field => [field.name, field.value]).map(([key, value]) => [key, value.trim()]));
  row.type = previous?.type || '现有联动';
  button.disabled = true;
  try {
    const saved = await request(id ? '/api/interfaces/' + encodeURIComponent(id) : '/api/interfaces', {
      method: id ? 'PUT' : 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(row)
    });
    ifaces = await request('/api/interfaces').catch(() =>
      [...ifaces.filter(item => item.id !== saved.id), saved]);
    $('#modalMask').classList.remove('open');
    $('#ifCnt').textContent = ifaces.length;
    renderIfaces();
  } catch (error) {
    alert('接口保存失败：' + error.message);
  } finally {
    button.disabled = false;
  }
};
$('#exportIf').onclick=()=>{
  const blob=new Blob([JSON.stringify(ifaces,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='mom_interfaces.json';a.click();
};

/* ---------- QA ---------- */
let qaFilter='全部',qaTerm='',qaPage=0;
const qaPageSize=60;
$('#qaPrev').onclick=()=>{qaPage--;renderQA()};
$('#qaNext').onclick=()=>{qaPage++;renderQA()};
const qaTypes=['全部','产品概述','模块清单','前置依赖','功能','联动','建议联动','手册场景','跨域业务参考','功能结构参考'];
$('#qaChips').innerHTML=qaTypes.map(t=>`<div class="chip ${t==='全部'?'active':''}" data-t="${t}">${t}</div>`).join('');
$$('#qaChips .chip').forEach(c=>c.onclick=()=>{$$('#qaChips .chip').forEach(x=>x.classList.remove('active'));c.classList.add('active');qaFilter=c.dataset.t;qaPage=0;renderQA()});
$('#qaSearch').oninput=e=>{qaTerm=e.target.value.trim().toLowerCase();qaPage=0;renderQA()};
function renderQA(){
  const list=G.qa.filter(q=>(qaFilter==='全部'||q.type===qaFilter)&&
    (!qaTerm||(q.q+q.a+q.tags+(P[q.product]?P[q.product].name:'')).toLowerCase().includes(qaTerm)));
  const lastPage=Math.max(0,Math.ceil(list.length/qaPageSize)-1);
  qaPage=Math.min(lastPage,Math.max(0,qaPage));
  $('#qaPrev').disabled=qaPage===0;
  $('#qaNext').disabled=qaPage===lastPage;
  $('#qaList').scrollTop=0;
  $('#qaCount').textContent=`共匹配 ${list.length} 条 · 第 ${qaPage+1}/${lastPage+1} 页${qaTerm?`（关键词：${qaTerm}）`:''}`;
  if(!list.length){$('#qaList').innerHTML='<div class="empty-state">没有匹配的问答，请调整关键词或筛选条件。</div>';return}
  $('#qaList').innerHTML=list.slice(qaPage*qaPageSize,(qaPage+1)*qaPageSize).map((q,i)=>`<div class="qa-item" data-i="${i}"><div class="qa-q"><span class="qmark">Q</span><span>${esc(q.q)}</span><span class="badge t-${q.type}">${q.type}</span></div><div class="qa-a"><div class="meta">产品：${esc(P[q.product]?.name||'补充手册')}${q.module?' · 模块：'+esc(q.module):''}</div>${esc(q.a).replaceAll('\n','<br>')}</div></div>`).join('');
  $$('#qaList .qa-item').forEach(it=>it.querySelector('.qa-q').onclick=()=>it.classList.toggle('open'));
}

/* ---------- init ---------- */
const graphWrap=$('#graphWrap');
graphWrap.addEventListener('dragstart',event=>event.preventDefault());
graphWrap.addEventListener('selectstart',event=>event.preventDefault());
graphWrap.addEventListener('copy',event=>event.preventDefault());
window.addEventListener('resize',()=>{if(curView==='graph')resizeGraph()});
setTimeout(()=>{
  resizeGraph();rebuild();renderQA();
  const id=new URLSearchParams(location.search).get('feature');
  if(!id)return;
  const selected=Object.hasOwn(FEAT_BY_ID,id)?FEAT_BY_ID[id]:null;
  if(selected){
    locateFeatureNode(selected,{details:true});
  }else{
    openDrawer('知识图谱','#2563eb','功能链接无法定位','',[{key:'info',label:'链接详情'}],
      {info:()=>`<p>当前图谱未登记编号为 <strong>${esc(id)}</strong> 的功能。可用「查找功能」核对名称或编号。</p>`});
  }
},60);
