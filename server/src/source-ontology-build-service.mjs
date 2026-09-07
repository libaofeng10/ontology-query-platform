const CATALOG_TASKS=["discovery","ontology_domain_modeling","ontology_generation","ontology_link_generation"];

// Selection, discovery and generation are one persisted job. A browser only
// starts/observes it; it never owns the transition between those stages.
export function createSourceOntologyBuildService({store,discovery,modeling,tasks,config}) {
  function assertCatalogIdle(sourceId) {
    const active=CATALOG_TASKS.map((type)=>store.findActiveTask(sourceId,type)).find(Boolean);
    if(active)throw httpError(409,"当前数据源正在探查或构建本体，请完成后再修改范围或启动新任务");
  }

  function status(sourceId) {
    const jobs=store.listTasks(sourceId);
    const builds=jobs.filter((task)=>task.taskType==="ontology_domain_modeling");
    return {
      task:builds.find((task)=>["queued","running"].includes(task.status))||builds[0]||null,
      modelingEnabled:config.ontologyAi.mode!=="off",
      profilingEnabled:Boolean(config.profiling?.enabled),
    };
  }

  async function start(source,input,actor) {
    if(!source.isDemo&&source.lastTestOk!==1)throw httpError(400,"真实数据源必须先通过只读连接测试");
    if(config.ontologyAi.mode==="off")throw httpError(409,"AI 本体生成尚未启用，请在设置中开启后再构建");
    let selections=normalizeSelections(input?.selections);
    const active=store.findActiveTask(source.id,"ontology_domain_modeling");
    if(active?.payload?.sourceBuild&&selectionKey(active.payload.sourceBuild.selections)===selectionKey(selections))return active;
    assertCatalogIdle(source.id);
    modeling.assertReady(source.id);
    const tables=await discovery.previewTables(source);
    const selected=new Set(selections.filter((item)=>item.included).map((item)=>item.tableName));
    const available=new Set(tables.map((item)=>item.tableName));
    const missing=[...selected].filter((name)=>!available.has(name));
    if(missing.length)throw httpError(400,`所选表已不存在，请刷新表清单：${missing.join("、")}`);
    selections=normalizeSelections(tables.map((table)=>({tableName:table.tableName,included:selected.has(table.tableName)})));
    // A second request can arrive while the physical catalog is being read.
    const pending=store.findActiveTask(source.id,"ontology_domain_modeling");
    if(pending?.payload?.sourceBuild&&selectionKey(pending.payload.sourceBuild.selections)===selectionKey(selections))return pending;
    assertCatalogIdle(source.id);
    return tasks.create({sourceId:source.id,taskType:"ontology_domain_modeling",payload:{actor,sourceBuild:{selections}}});
  }

  async function run(context) {
    const {task,source,payload,onProgress}=context;
    let checkpoint=payload.sourceBuild;
    const save=(next)=>{
      checkpoint={...checkpoint,...next};
      store.updateTaskPayload(task.id,{...payload,sourceBuild:checkpoint});
    };
    if(!checkpoint.discovery) {
      if(!source.isDemo&&source.lastTestOk!==1)throw httpError(400,"真实数据源必须先通过只读连接测试");
      onProgress({progress:1,total:100,currentStep:"正在保存选表范围"});
      store.saveTableSelections(source.id,checkpoint.selections,payload.actor);
      store.purgeExcludedTables(source.id);
      const result=await discovery.discover(source,{tableNames:checkpoint.selections.filter((item)=>item.included).map((item)=>item.tableName),onProgress:(step)=>onProgress({
        ...step,total:100,progress:Math.round(Math.min(100,step.progress)*.35),currentStep:`读取数据结构：${step.currentStep}`,
      })});
      save({discovery:result});
    }
    const result=await modeling.run({
      ...context,payload:{...payload,domainPlanSnapshot:checkpoint.plan},
      onPlan:(plan)=>{if(!checkpoint.plan)save({plan});},
      onProgress:(step)=>onProgress({...step,total:100,progress:35+Math.round(Math.min(100,step.progress)*.65)}),
    });
    return {...result,discovery:checkpoint.discovery};
  }

  return {start,run,status,assertCatalogIdle};
}

function normalizeSelections(value) {
  if(!Array.isArray(value)||!value.length)throw httpError(400,"请选择需要构建本体的数据表");
  const names=new Set();
  const result=value.map((item)=>{
    if(typeof item?.tableName!=="string"||!item.tableName.trim()||typeof item.included!=="boolean")throw httpError(400,"选表范围必须包含表名和明确的勾选状态");
    const tableName=item.tableName.trim();
    if(names.has(tableName))throw httpError(400,`选表范围存在重复表：${tableName}`);
    names.add(tableName);
    return {tableName,included:item.included};
  }).sort((left,right)=>left.tableName.localeCompare(right.tableName));
  if(!result.some((item)=>item.included))throw httpError(400,"请至少选择一张表");
  return result;
}

function selectionKey(selections){return JSON.stringify(selections.filter((item)=>item.included).map((item)=>item.tableName).sort());}

function httpError(status,message){const error=new Error(message);error.status=status;return error;}
