import { batchProcessModels, batchProcessFunctions, batchProcessRelations } from './batch-process-model.js';
import { projectionReview } from './projection-review.js';
import { verifiedFeatureNotes, workPermitNotes, engineeringFunctions, engineeringRelations } from './engineering-evidence.js';
import { reviewedDependencies } from './business-dependencies.js';
import { planningFeatures, planningScenarios } from './planning-links.js';

const referenceModels = [
  {id:'eam-M7', code:'eam', name:'巡检协同（规划参考）', evidence:'planning',
    desc:'为查看规划图，巡检协同模型挂在设备管理导航下。原图覆盖工艺、设备和安全三类巡检，各自的标准和处置责任需单独核对，实际统一巡检平台归属待确认。'},

  {id:'processref-M7', code:'processref', name:'生产计划分解', evidence:'planning',
    desc:'规划图明确由年、月计划进入日计划分解。计划生成口径及发布配置需项目确认。'},
  {id:'processref-M8', code:'processref', name:'开停车与工况执行', evidence:'planning',
    desc:'规划图描述开停车和工况调整两条路径，以及外部自动执行和运行反馈。实际控制系统边界需按项目确认。'},
  {id:'processref-M9', code:'processref', name:'生产实绩', evidence:'planning',
    desc:'规划图描述日产量实绩、每日对比及后续物料平衡。生产日界线与统计口径需按项目确认。'},

  {id:'batchref-M4', code:'batchref', name:'排程协同', evidence:'planning',
    desc:'规划范围内核对外部排程与 MOM 工单计划的交互。实际 APS 分工、发单及反馈配置需按项目确认。'},
  {id:'batchref-M5', code:'batchref', name:'批控协同', evidence:'planning',
    desc:'规划范围内核对配方参数下发和批控状态回传。批控侧执行及实际系统边界需按项目确认。'},

  {id:'processref-M5', code:'processref', name:'罐区管理'},
  {id:'processref-M6', code:'processref', name:'操作管理'},
];

const scheduling = [
  ['bd-M2-F1','bd-M2-F4','选择排班班次','排班周期引用已维护的班次编码和起止时间。','基础数据功能说明 · 班次维护、排班周期维护'],
  ['bd-M2-F2','bd-M2-F3','初始化部门班组','按部门引入已维护的班组，再配置班组长。','基础数据功能说明 · 班组维护、班组和班组长维护'],
  ['bd-M2-F2','bd-M2-F4','引入排班班组','排班周期维护引用已维护的班组。','基础数据功能说明 · 班组维护、排班周期维护'],
  ['bd-M2-F3','bd-M2-F4','确定班组长和成员归属','生成排班时使用班组长和成员归属信息。','基础数据功能说明 · 班组和班组长维护'],
  ['bd-M2-F4','bd-M2-F5','生成供查询的排班结果','排班周期生成按部门、日期、班次和班组记录的排班结果，供排班查询展示。','基础数据功能说明 · 排班周期维护、排班查询'],
  ['bd-M2-F5','processref-M6-REF-F2','运行记录按岗位关联排班','运行记录模板按岗位关联班次数据。箭头表示排班结果数据被引用，具体读取接口、表及岗位映射待项目核验。','连续生产执行分册 · 操作管理手册 p.55、p.58（§4.8.1）；基础数据功能说明 · 排班查询'],
].map(([source,target,scene,label,basis])=>[source,target,'排班数据协同',scene,label,basis]);

const referenceFunctions = [
  ['processref-M6', 'processref-M6-REF-F2', '运行记录模板配置', '模板可按岗位关联班次数据。资料定位：操作管理手册 p.55、p.58（§4.8.1）。'],
  ['batchref-M2', 'batchref-M2-F3', '批次投料单', '手册场景涉及的投料业务单据。'],
  ['wms-M4', 'wms-M4-REF-F1', '生产出库单', '接收批次投料信息生成的生产出库单。'],
  ['lim-M3', 'lim-M3-REF-F1', '产品请检单', '实验室接收生产请检并开展检验。'],
  ['lim-M3', 'lim-M3-REF-F2', '质量校验状态', '资料确认罐区会取质量校验状态，提供状态的具体功能和接口待项目核验。'],
  ['processref-M5', 'processref-M5-F1', '油品移动记录', '罐区记录读取实验室质量校验状态。'],
  ['processref-M6', 'processref-M6-F1', '操作超时提醒', '运行记录配置超时提醒及接收人后，超时未确认时触发待办通知。'],
];

const scenarios = [
  ['batchref-M3-F1', 'lim-M3-REF-F1', '生产质量协同', '生产请检对接实验室',
    '制造指令发起请检，检验活动转接实验室，检验结论按资料所述流程回填。', '功能结构总纲 §4.1 · 批次 §6.1.2、§6.1.7'],
  ['batchref-M2-F3', 'wms-M4-REF-F1', '生产与库存协同', '投料触发生产出库',
    '批次投料单通过内部接口生成生产出库单。', '功能结构总纲 §4.1 · 仓储手册 p.8、p.84'],
  ['lim-M3-REF-F2', 'processref-M5-F1', '生产质量协同', '罐区取质量校验状态',
    '罐区油品移动记录从实验室管理读取质量校验状态。接口与字段待核验。', '功能结构总纲 §4.3 · 罐区 p.50'],
  ['processref-M6-F1', 'sm-M24-F1', '生产任务协同', '操作超时推送待办',
    '运行记录配置超时提醒及推送人员后，记录超时未确认时，向消息中心发送待办。', '连续生产执行分册 · 操作管理手册 p.56，§4.8.1'],
];

export function withProductionLinks(graph) {
  const modules = new Map(graph.modules.map(m => [m.id, {...m, features:[...m.features]}]));
  for (const m of modules.values()) {
    m.features=m.features.map(feature=>{
      if(feature.desc?.trim())return feature;
      if(feature.id==='hse-M5-F7')return {...feature,
        descriptionBasis:'安环管理使用手册第 4232、4367、4505 行。公司、车间与班组检查登记的隐患考核金额供奖惩管理使用；同模型的手册参考节点展示另一套实现的配置和上报审核。本产品的计算、审核、撤销及结果回写规则仍缺少直接依据。',
      };
      const permit=m.id==='hse-M3'&&workPermitNotes[feature.name];
      const note=permit?[
        `录入作业地点、起止时间、作业人与监护人，填写${permit}，并确认危害识别和风险安全措施。可按作业票配置关联安全交底或 JSA。`,
        '安全生产分册第 224 行 · 作业管理手册 §7.2.2–7.2.9',
      ]:verifiedFeatureNotes[feature.id];
      return note?{...feature,desc:note[0],descriptionBasis:note[1]}:feature;
    });
  }
  for (const model of [...referenceModels,...batchProcessModels]) {
    if (graph.products.some(p => p.code === model.code) && !modules.has(model.id)) {
      modules.set(model.id, {...model, features:[]});
    }
  }
  const plannedNodes = planningFeatures.map(([moduleId,id,name])=>[
    moduleId,id,name,'2027 年业务流向图中的规划环节，实施与项目配置待核验。','planning',
  ]);
  for (const [moduleId, id, name, desc, evidence] of [...referenceFunctions,...plannedNodes,...engineeringFunctions,...batchProcessFunctions]) {
    const model = modules.get(moduleId);
    if (model && !model.features.some(feature => feature.id === id)) {
      model.features.push({id, name, desc, reference:true, evidence});
    }
  }
  const owners = new Map([...modules.values()].flatMap(m => m.features.map(f => [f.id, m])));
  const featureRefs = [...graph.featureRefs];
  const moduleRefs = [...graph.moduleRefs];
  const features = new Map([...modules.values()].flatMap(m => m.features.map(f => [f.id, f])));
  const registeredPairs = new Set(featureRefs.filter(r=>r.type==='exist'&&!projectionReview(r))
    .map(r=>JSON.stringify([r.sourceFeature,r.targetFeature])));
  const reviewed = reviewedDependencies.flatMap(([src,dst,scene])=>{
    if(registeredPairs.has(JSON.stringify([src,dst]))||!features.has(src)||!features.has(dst))return [];
    return [[src,dst,'业务数据依赖',scene,scene,
      `现有功能说明 · ${features.get(src).name}、${features.get(dst).name}`,'reviewed']];
  });
  const productGroups = new Map();
  const modelGroups = new Map();
  const group = (groups,key,data) => {
    const current=groups.get(key);
    const scenario={scene:data.scenario||data.scene,label:data.label,basis:data.basis};
    if(current)current.scenarios.push(scenario);
    else groups.set(key,{...data,scenarios:[scenario]});
  };
  for(const [index,row] of planningScenarios.entries()){
    if(row.length!==7||row[6]!=='planning'||!row[5]){
      throw new Error(`规划关系第 ${index+1} 条缺少分类或来源定位`);
    }
  }
  [...scenarios,...planningScenarios,...scheduling,...reviewed,...engineeringRelations,...batchProcessRelations].forEach(([sourceFeature, targetFeature, category, scene, label, basis, evidence], index) => {
    const src = owners.get(sourceFeature);
    const dst = owners.get(targetFeature);
    if (!src || !dst) return;
    const common = {source:src.code, target:dst.code, sourceModule:src.id, targetModule:dst.id,
      type:'exist', reference:true, evidence, scene, label, basis};
    featureRefs.push({...common, id:`PROD-F-${index+1}`, sourceFeature, targetFeature});
    if(src.id!==dst.id)group(modelGroups,JSON.stringify([src.id,dst.id,evidence]),
      {...common,id:`PROD-M-${index+1}`});
    if(src.code!==dst.code&&evidence!=='reviewed')group(productGroups,JSON.stringify([src.code,dst.code,evidence]),
      {...common,scene:category,scenario:scene});
  });
  moduleRefs.push(...modelGroups.values());
  return {...graph, modules:[...modules.values()], moduleRefs, featureRefs, productLinks:[...productGroups.values()]};
}
