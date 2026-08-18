import { randomUUID } from "node:crypto";

export function createTaskService({store,discovery,handlers={}}) {
  const active=new Map();
  const runners=new Map(Object.entries(handlers));
  runners.set("discovery",async({source,onProgress})=>discovery.discover(source,{onProgress}));
  let closing=false;

  function createDiscoveryTask(source) {
    return create({sourceId:source.id,taskType:"discovery"});
  }

  function create({id=randomUUID(),sourceId,taskType,payload={}}) {
    const existing=store.findActiveTask(sourceId,taskType);
    if(existing) return existing;
    const task=store.createTask({id,sourceId,taskType,payloadJson:JSON.stringify(payload)});
    schedule(task.id);
    return task;
  }

  function schedule(taskId) {
    if(closing||active.has(taskId)) return;
    const promise=Promise.resolve().then(()=>run(taskId)).finally(()=>active.delete(taskId));
    active.set(taskId,promise);
  }

  async function run(taskId) {
    const queued=store.getTask(taskId);
    if(!queued||!['queued','running'].includes(queued.status)) return;
    const source=store.getSource(queued.sourceId);
    if(!source) { store.failTask(taskId,"数据源不存在，任务无法恢复"); return; }
    store.startTask(taskId);
    try {
      const runner=runners.get(queued.taskType);
      if(!runner) throw new Error(`不支持的任务类型：${queued.taskType}`);
      const result=await runner({task:queued,source,payload:queued.payload,onProgress:(step)=>store.updateTaskProgress(taskId,step)});
      store.completeTask(taskId,result);
    } catch(error) {
      store.failTask(taskId,error?.message||String(error));
    }
  }

  function recover() {
    store.requeueInterruptedTasks();
    for(const task of store.listRecoverableTasks()) schedule(task.id);
  }

  async function close() {
    closing=true;
    await Promise.allSettled([...active.values()]);
  }

  return {create,createDiscoveryTask,get:(id)=>store.getTask(id),list:(sourceId)=>store.listTasks(sourceId),recover,close};
}
