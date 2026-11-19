import { projectionReview } from './projection-review.js';

export const objectTypes = {
  master: {
    person: {label:'人员', key:'人员编号', sample:'P-DEMO-01',
      steps:['人员主数据','业务任务分派','任务处理记录'], links:['按人员编号指定处理人','关联实际处理人和处理时间'],
      fields:'人员表、组织及岗位表、任务分派表、任务处理记录表。提供人员主键、人员编号、岗位及组织外键、任务主键、处理人字段与生效时间。',
      rules:'区分发起人、指定处理人、代理人和实际处理人。提供权限范围、岗位变更和任务委托生效规则。'},
    equipment: {label:'设备', key:'设备编号', sample:'001',
      steps:['设备台账','设备运行统计','OEE 统计'], links:['引用设备主键和归属产线','提供运行及停机时长'],
      fields:'设备台账、运行及停机事件、OEE 结果表。提供设备主键、设备编号、产线键、事件起止时间、统计周期和结果主键。',
      rules:'提供设备与产线映射、运行状态口径、停机归类、换班归属和 OEE 计算公式及版本。'},
    material: {label:'物料', key:'物料编码', sample:'MAT-DEMO-01',
      steps:['物料主数据','入库单明细','库存记录'], links:['按物料主键引用编码及计量单位','通过入库过账更新库存'],
      fields:'物料主数据、物料单位换算、入库单头及行、库存事务表。提供物料主键、物料编码、单据行主键、仓库及批次键、数量与单位。',
      rules:'提供物料版本、单位换算、过账及冲销规则，明确跨组织物料编码映射。'},
  },
  business: {
    batch: {label:'批号', key:'批号', sample:'LOT-DEMO-01',
      steps:['物料批次','投料记录','产出批次'], links:['按原料批次键关联实际投料','按生产执行记录关联产出'],
      fields:'批次主表、投料、产出及批次谱系表。提供批次主键、批号、物料与工厂键、父子批次键、数量与生产记录主键。',
      rules:'定义批号唯一范围、拆批并批、混用、返工和退料规则，明确谱系关系记录时点。'},
    document: {label:'业务单据号', key:'单据号', sample:'WO-DEMO-01',
      steps:['维修工单','处理记录','验收记录'], links:['以工单主键关联执行记录','提交处理结果供验收'],
      fields:'单据类型字典、各类单据头及行、单据关系、处理与验收记录表。提供单据类型、单号、单据主键、行主键、来源单据键、状态及时间。',
      rules:'提供单号唯一范围及类型映射，说明建单、变更、审批、完工、验收及撤销触发条件。'},
  },
};

export function prototypeGraph(type) {
  const nodes = [{id:'object', label:type.sample, kind:`模拟${type.label}`, details:'演示编号。'}];
  const edges = [{from:'object', to:'step-0', label:'定位示例对象'}];
  type.steps.forEach((label, i) => {
    nodes.push({id:`step-${i}`, label, kind:'原型环节', details:'原型中的候选业务环节，需以实际配置和记录验证。'});
    if (i) edges.push({from:`step-${i-1}`, to:`step-${i}`, label:type.links[i-1]});
  });
  return {title:`${type.label}追溯原型`, demo:true, nodes, edges, focus:'object'};
}

export function featureTrace(graph, featureId, {direction='both', depth=1, includePlanning=true}={}) {
  const features = new Map(graph.modules.flatMap(module => module.features.map(feature => [
    feature.id, {...feature, module:module.name, product:graph.products.find(p => p.code === module.code).name},
  ])));
  const selected = features.get(featureId);
  if (!selected) return null;
  const outgoing = new Map([...features.keys()].map(id=>[id,[]]));
  const incoming = new Map([...features.keys()].map(id=>[id,[]]));
  const excluded = graph.featureRefs.filter(ref=>projectionReview(ref)&&
    (ref.sourceFeature===featureId||ref.targetFeature===featureId)).length;
  for(const ref of graph.featureRefs){
    if(projectionReview(ref)||!features.has(ref.sourceFeature)||!features.has(ref.targetFeature))continue;
    if(!includePlanning&&(ref.type==='sugg'||ref.evidence==='planning'))continue;
    outgoing.get(ref.sourceFeature).push(ref);
    incoming.get(ref.targetFeature).push(ref);
  }
  const refs = new Set();
  const levels = new Map([[featureId,0]]);
  function follow(adjacency, peerKey, sign){
    const visited=new Set([featureId]);
    const queue=[[featureId,0]];
    for(const [id,distance] of queue){
      if(distance>=depth)continue;
      for(const ref of adjacency.get(id)){
        const peer=ref[peerKey];
        refs.add(ref);
        if(!levels.has(peer))levels.set(peer,sign*(distance+1));
        if(visited.has(peer))continue;
        visited.add(peer);
        queue.push([peer,distance+1]);
      }
    }
  }
  if(direction!=='upstream')follow(outgoing,'targetFeature',1);
  if(direction!=='downstream')follow(incoming,'sourceFeature',-1);
  const directionLabel={both:'上下游',upstream:'上游',downstream:'下游'}[direction];
  return {
    title:`${selected.name} · 知识图谱资料 · ${refs.size ? `${directionLabel} · ${depth} 级` : '所选范围暂无已登记关系'}${excluded?` · ${excluded} 条历史映射见图谱功能详情`:''}`,
    nodes:[...levels].map(([id,level]) => {
      const feature = features.get(id);
      return {id, level, label:feature.name, kind:`${feature.product} / ${feature.module}`, details:[feature.desc, feature.descriptionBasis].filter(Boolean).join(' · ')};
    }),
    edges:[...refs].map(ref => {
      const evidence = ref.evidence === 'planning' ? '规划参考' : ref.evidence === 'reviewed' ? '现有功能说明' : ref.reference ? '手册场景参考' : ref.internal ? '功能说明整理' : ref.type === 'sugg' ? '建议关系' : '产品联动推导';
      return {from:ref.sourceFeature, to:ref.targetFeature, planning:ref.type==='sugg'||ref.evidence==='planning', label:`${evidence} · ${ref.scene || ref.label}`,
        details:[ref.label, ref.basis, ref.interfaceId && `关联接口 ${ref.interfaceId}`, '实际启用配置与数据流向待核验。'].filter(Boolean).join('；')};
    }),
    focus:featureId,
  };
}
