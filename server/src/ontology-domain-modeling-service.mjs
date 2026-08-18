export function createOntologyDomainModelingService({domainPlanner,candidates}={}) {
  if(!domainPlanner?.plan)throw new Error("全域自动建模需要业务域规划服务");
  if(!candidates?.createRun||!candidates?.runGeneration||!candidates?.listRuns)throw new Error("全域自动建模需要候选生成服务");

  function assertReady(sourceId) {
    const active=candidates.listRuns(sourceId).find((run)=>["queued","running"].includes(run.status));
    if(active)throw httpError(409,`已有业务域正在建模：${active.scope.domainName||active.id}`);
  }

  async function run({task,source,payload,onProgress=()=>{}}={}) {
    const actor=String(payload?.actor||"system");
    onProgress({progress:1,total:100,currentStep:"正在自动划分业务域"});
    const plan=await domainPlanner.plan(source.id,{refresh:payload?.refreshDomainPlan!==false,actor});
    const selectedIds=new Set(Array.isArray(payload?.domainIds)?payload.domainIds.map(String):[]);
    const domains=(plan.domains||[]).filter((domain)=>!selectedIds.size||selectedIds.has(String(domain.id)));
    if(!domains.length)throw httpError(400,"业务域计划中没有可执行的域");

    const priorRuns=candidates.listRuns(source.id).filter((run)=>run.scope?.orchestrationId===task.id);
    const results=[];
    for(let index=0;index<domains.length;index++) {
      const domain=domains[index];
      const start=5+Math.floor(index*90/domains.length);
      const span=Math.max(1,Math.floor(90/domains.length));
      const domainLabel=domain.batchCount>1?`${domain.name}（${domain.batchIndex}/${domain.batchCount}）`:domain.name;
      onProgress({progress:start,total:100,currentStep:`正在建模 ${domainLabel}：Object 与 Link`});
      let runRecord=priorRuns.find((item)=>item.scope?.domainPlanId===domain.id)||null;
      try {
        if(!runRecord)runRecord=candidates.createRun({
          sourceId:source.id,
          tableNames:domain.tables.map((table)=>table.tableName),
          domainName:domainLabel,
          domainDescription:domain.description,
          orchestrationId:task.id,
          domainPlanId:domain.id,
          domainKey:domain.domainKey,
          domainBatchIndex:domain.batchIndex,
          domainBatchCount:domain.batchCount,
        },actor,{taskId:task.id});
        const summary=await candidates.runGeneration({payload:{runId:runRecord.id},onProgress:(step)=>{
          const childProgress=Math.max(0,Math.min(100,Number(step?.progress)||0));
          onProgress({progress:Math.min(94,start+Math.floor(span*childProgress/100)),total:100,currentStep:`${domainLabel}：${step?.currentStep||"正在生成候选"}`});
        }});
        results.push({domainId:domain.id,domainName:domainLabel,runId:runRecord.id,status:"succeeded",objectCount:Number(summary.objectCount||0),linkCount:Number(summary.linkCount||0),autoConfirmedCount:Number(summary.autoConfirmedCount||0),reviewRequiredCount:Number(summary.reviewRequiredCount||0),blockedCount:Number(summary.blockedCount||0)});
      } catch(error) {
        results.push({domainId:domain.id,domainName:domainLabel,runId:runRecord?.id||null,status:"failed",error:String(error?.message||error),objectCount:0,linkCount:0,autoConfirmedCount:0,reviewRequiredCount:0,blockedCount:0});
      }
    }

    const succeeded=results.filter((item)=>item.status==="succeeded");
    if(!succeeded.length)throw new Error(`全部 ${domains.length} 个业务域建模失败：${results.map((item)=>`${item.domainName}：${item.error}`).join("；")}`);
    const aggregate=(key)=>succeeded.reduce((sum,item)=>sum+Number(item[key]||0),0);
    const result={
      sourceId:source.id,domainCount:domains.length,succeededDomainCount:succeeded.length,failedDomainCount:domains.length-succeeded.length,
      objectCount:aggregate("objectCount"),linkCount:aggregate("linkCount"),autoConfirmedCount:aggregate("autoConfirmedCount"),reviewRequiredCount:aggregate("reviewRequiredCount"),blockedCount:aggregate("blockedCount"),
      runIds:succeeded.map((item)=>item.runId),domains:results,
    };
    onProgress({progress:100,total:100,currentStep:result.failedDomainCount?`全域建模完成，${result.failedDomainCount} 个域失败`:`${result.domainCount} 个业务域已完成 Object 与 Link 建模`});
    return result;
  }

  return {assertReady,run};
}

function httpError(status,message){const error=new Error(message);error.status=status;return error;}
