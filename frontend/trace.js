import { objectTypes, prototypeGraph, featureTrace } from './trace-catalog.js';

export function bindTrace(request, esc, knowledgeGraph, locateFeature) {
  const find = id => document.getElementById(id);
  const query = find('traceQuery');
  const status = find('traceStatus');
  const canvas = find('traceCanvas');
  const details = find('traceDetails');
  let sequence = 0;

  function render({title, nodes, edges, focus, demo}, {featureGraph=false}={}) {
    status.textContent = `${demo ? '模拟数据 · ' : ''}${title} · ${nodes.length} 个节点 · ${edges.length} 条关系`;
    if (!nodes.length) {
      canvas.textContent = '暂无追溯节点。';
      return;
    }
    const byId = new Map(nodes.map(node => [node.id, node]));
    const levels = new Map();
    const outgoing = new Map(nodes.map(node => [node.id, []]));
    const targets = new Set();
    for (const edge of edges) {
      outgoing.get(edge.from).push(edge.to);
      targets.add(edge.to);
    }
    const roots = nodes.filter(node => !targets.has(node.id));
    for (const node of [...roots, ...nodes]) {
      if (levels.has(node.id)) continue;
      levels.set(node.id, 0);
      const queue = [node.id];
      for (const id of queue) {
        for (const next of outgoing.get(id)) {
          if (levels.has(next)) continue;
          levels.set(next, levels.get(id) + 1);
          queue.push(next);
        }
      }
    }

    const hasTraceLevels=nodes.every(node=>Number.isInteger(node.level));
    const minimumLevel=hasTraceLevels?Math.min(...nodes.map(node=>node.level)):0;
    const rows = new Map();
    const points = new Map(nodes.map(node => {
      const level = hasTraceLevels?node.level-minimumLevel:levels.get(node.id);
      const row = rows.get(level) || 0;
      rows.set(level, row + 1);
      return [node.id, {x: 32 + 272 * level, y: 34 + 104 * row}];
    }));
    const width = 290 + 272 * Math.max(...rows.keys());
    const height = 125 + 104 * (Math.max(...rows.values()) - 1);
    const relation = edge => `${byId.get(edge.from).label} → ${byId.get(edge.to).label} · ${edge.label}`;
    canvas.innerHTML = `<div class="trace-map" style="width:${width}px;height:${height}px">
      <svg width="${width}" height="${height}" aria-label="箭头表示数据流向">
        <defs><marker id="traceArrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10Z" fill="#64748b"/>
        </marker></defs>
        ${edges.map(edge => {
          const start = points.get(edge.from);
          const end = points.get(edge.to);
          const forward = end.x > start.x;
          const sameColumn = start.x === end.x;
          const a = start.x + (forward || sameColumn ? 200 : 0);
          const b = end.x + (forward ? 0 : 200);
          const y = start.y + 32;
          const z = end.y + 32;
          const bend = sameColumn ? a + 48 : (a + b) / 2;
          const path = start === end
            ? `M${a} ${y - 12} C${bend} ${y - 32} ${bend} ${y + 32} ${b} ${z + 12}`
            : `M${a} ${y} C${bend} ${y} ${bend} ${z} ${b} ${z}`;
          return `<path class="trace-edge${edge.planning?' planned':''}" tabindex="0" role="button" aria-label="${esc(relation(edge))}"
            marker-end="url(#traceArrow)" d="${path}"><title>${esc(relation(edge))}</title></path>`;
        }).join('')}
      </svg>
      ${nodes.map(node => {
        const {x, y} = points.get(node.id);
        return `<button class="trace-node" aria-pressed="false" title="${esc(node.label)}"
          style="left:${x}px;top:${y}px"><strong>${esc(node.label)}</strong><small>${esc(node.kind)}</small></button>`;
      }).join('')}
    </div>`;

    const buttons = [...canvas.querySelectorAll('.trace-node')];
    const paths = [...canvas.querySelectorAll('.trace-edge')];
    function select(nodeId, edgeIndex) {
      buttons.forEach((button, i) => button.setAttribute('aria-pressed', nodes[i].id === nodeId));
      paths.forEach((path, i) => path.classList.toggle('active',
        i === edgeIndex || edges[i].from === nodeId || edges[i].to === nodeId));
      details.hidden = false;
    }

    function showEdge(index) {
      const edge = edges[index];
      select(null, index);
      details.innerHTML = `<h3>${esc(edge.label)}</h3>
        <p>${esc(byId.get(edge.from).label)} → ${esc(byId.get(edge.to).label)}</p>
        <p>${esc(edge.details || '暂无关系说明')}</p>`;
    }

    function showNode(node) {
      select(node.id, -1);
      const links = (field, heading) => {
        const items = edges.map((edge, i) => edge[field] === node.id
          ? `<button class="icon-btn" data-edge="${i}">${esc(relation(edge))}</button>` : '').join('');
        return items ? `<p><strong>${heading}</strong><br>${items}</p>` : '';
      };
      details.innerHTML = `<h3>${esc(node.label)}</h3>
        <p>${esc(node.details || node.kind)}</p>
        ${featureGraph?`<button class="icon-btn" type="button" data-trace-locate>在知识图谱定位</button>`:''}
        ${links('to', '上游来源')}${links('from', '下游用途')}`;
      const locate=details.querySelector('[data-trace-locate]');
      if(locate)locate.onclick=()=>locateFeature(node.id);
      details.querySelectorAll('[data-edge]').forEach(button => {
        button.onclick = () => {
          const index = Number(button.dataset.edge);
          showEdge(index);
          paths[index].focus();
        };
      });
    }

    buttons.forEach((button, i) => button.onclick = () => showNode(nodes[i]));
    paths.forEach((path, i) => {
      path.onclick = () => showEdge(i);
      path.onkeydown = event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        showEdge(i);
      };
    });
    if (byId.has(focus)) showNode(byId.get(focus));
  }

  const type = find('traceType');
  const category = find('traceCategory');
  const feature = find('traceFeature');
  const options = find('traceFeatureOptions');
  const traceDirection=find('traceDirection');
  const traceDepth=find('traceDepth');
  const tracePlanning=find('tracePlanning');
  const demoButton = find('traceDemo');
  const submit = find('traceSubmit');
  const lookup = () => objectTypes[type.value]?.[category.value];

  function clear(message) {
    sequence++;
    canvas.replaceChildren();
    details.hidden = true;
    status.textContent = message;
  }

  function updateRequirements() {
    const object = lookup();
    let fields = object?.fields;
    let rules = object?.rules;
    if (type.value === 'feature') {
      fields = '提供功能及菜单配置表、表单头和明细表、流程定义与实例表、接口及事件配置。包括功能编码、表单编码、业务主键、流程版本、源目标系统与字段映射。';
      rules = '提供已启用的表单字段及读写规则、前置单据、触发动作、状态流转、审批与回调配置。注明适用组织及版本，附一条可校验的业务记录链。';
    }
    find('traceRequirementBody').innerHTML = `
      <p><strong>通用资料</strong> · 提供脱敏样例、字段字典、主外键、组织及时间范围、查询权限和数据来源。</p>
      ${fields ? `<p><strong>表结构与关联键</strong> · ${esc(fields)}</p><p><strong>业务功能配置细则</strong> · ${esc(rules)}</p>`
        : '<p>选择细分类后查看对应的数据表结构和业务配置要求。</p>'}
    `;
  }

  function updateTarget() {
    const object = lookup();
    const features = type.value === 'feature' && category.value
      ? knowledgeGraph.modules.filter(m => m.code === category.value) : [];
    query.value = '';
    query.hidden = !object;
    find('traceTargetLabel').hidden = !object;
    if (object) {
      find('traceTargetLabel').textContent = object.key;
      query.placeholder = '输入' + object.key;
    }
    feature.hidden = !features.length;
    options.hidden = feature.hidden;
    find('traceFeatureLabel').hidden = feature.hidden;
    feature.innerHTML = '<option value="">请选择功能</option>' + features.map(module =>
      `<optgroup label="${esc(module.name)}">${module.features.map(f =>
        `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</optgroup>`).join('');
    demoButton.hidden = !object && !features.length;
    demoButton.disabled = !object;
    submit.disabled = true;
    updateRequirements();
    find('traceRequirements').open = Boolean(object || features.length);
    clear(object ? `输入${object.key}，或查看模拟原型。现有知识图谱不包含对象的实际业务记录。`
      : features.length ? '请选择业务功能，查看已整理的功能说明和关联依据。'
      : type.value ? '请选择细分类。' : '请先选择查询数据类型。');
  }

  type.onchange = () => {
    const choices = type.value === 'feature'
      ? knowledgeGraph.products.filter(p => knowledgeGraph.modules.some(m => m.code === p.code && m.features.length))
        .map(p => [p.code, p.name])
      : Object.entries(objectTypes[type.value] || {}).map(([id, item]) => [id, item.label]);
    find('traceCategoryLabel').textContent = type.value === 'feature' ? '所属产品' : '细分类';
    category.innerHTML = '<option value="">请选择</option>' + choices.map(([id, label]) =>
      `<option value="${esc(id)}">${esc(label)}</option>`).join('');
    category.disabled = !choices.length;
    updateTarget();
  };
  category.onchange = updateTarget;
  feature.onchange = () => {
    submit.disabled = !feature.value;
    demoButton.disabled = !feature.value;
    clear(feature.value ? '选择追溯方向和层数后查询。' : '请选择业务功能。');
  };
  for(const control of [traceDirection,traceDepth,tracePlanning]){
    control.onchange=()=>clear('追溯条件已更新，点击查询刷新结果。');
  }
  query.oninput = () => {
    submit.disabled = !query.value.trim();
    clear('可按所选分类查询实际记录，或查看模拟原型。');
  };

  function renderFeature(){
    clear('');
    const graph=featureTrace(knowledgeGraph,feature.value,{
      direction:traceDirection.value,depth:Number(traceDepth.value),includePlanning:tracePlanning.checked,
    });
    if(graph)render(graph,{featureGraph:true});
  }

  find('traceForm').onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    if (type.value === 'feature') {
      renderFeature();
      return;
    }
    clear('正在查询业务记录…');
    const current = sequence;
    try {
      const params = new URLSearchParams({
        mode:'object', type:type.value, category:category.value, id:query.value.trim(),
      });
      const graph = await request('/api/trace?' + params);
      if (current === sequence) render(graph);
    } catch (error) {
      if (current === sequence) {
        status.textContent = error.message;
        find('traceRequirements').open = true;
      }
    }
  };
  demoButton.onclick = () => {
    const object = lookup();
    if (object) {
      clear('');
      render(prototypeGraph(object));
      return;
    }
    const graph = featureTrace(knowledgeGraph, feature.value);
    if (!graph) return;
    clear('');
    render({
      title:'功能配置追溯原型', demo:true, focus:'function',
      nodes:[
        {id:'trigger', label:'候选触发动作', kind:'原型环节', details:'实际触发动作及适用条件由功能配置确认。'},
        {id:'function', label:graph.nodes[0].label, kind:'所选功能 · 原型演示', details:'此场景用于演示如何核查功能触发、表单数据与后续动作。'},
        {id:'result', label:'候选状态变更或回调', kind:'原型环节', details:'实际状态变化、目标及字段映射由流程或接口配置确认。'},
      ],
      edges:[
        {from:'trigger', to:'function', label:'核查触发条件和表单入参'},
        {from:'function', to:'result', label:'核查状态变化或事件输出'},
      ],
    });
  };
  updateTarget();

  return function traceFeature(productCode, id){
    type.value='feature';
    type.onchange();
    category.value=productCode;
    updateTarget();
    feature.value=id;
    feature.onchange();
    if(feature.value)renderFeature();
  };
}
