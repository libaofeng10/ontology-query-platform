"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "./icons";
import { fitGraph, graphView, GRAPH_NODE as NODE, GRAPH_VIEW as VIEW, layoutGraph, zoomGraph } from "./graph-layout.mjs";
import type { GraphTransform } from "./graph-layout.mjs";
import type { DataSource, NavId, OntologyGraph, OntologyGraphEdge, OntologyGraphNode } from "./types";
import "./ontology-graph.css";

type Kind=OntologyGraphNode["kind"];
type Mode="semantic"|"mapping"|"all";
const kinds:Kind[]=["object","table","term","metric","rule"];
const kindLabel:Record<Kind,string>={object:"业务对象",table:"数据表",term:"术语",metric:"指标",rule:"规则"};
const edgeLabel:Record<OntologyGraphEdge["kind"],string>={semantic:"业务关系",mapping:"属性映射",join:"表关联",subclass:"继承关系",binding:"知识关联",wikilink:"知识引用"};

export function OntologyGraphWorkspace({graph,source,onNavigate}:{graph:OntologyGraph|null;source:DataSource|null;onNavigate:(id:NavId)=>void}) {
  const [mode,setMode]=useState<Mode>(graph?.stats.objects?"semantic":"mapping");
  const [enabled,setEnabled]=useState<Partial<Record<Kind,boolean>>>({});
  const [confirmedOnly,setConfirmedOnly]=useState(false);
  const [search,setSearch]=useState("");
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [focus,setFocus]=useState(false);
  const [viewport,setViewport]=useState<(GraphTransform&{key:string})|null>(null);
  const svgRef=useRef<SVGSVGElement>(null);
  const drag=useRef<{point:{x:number;y:number};view:GraphTransform}|null>(null);
  const markerId=useId().replaceAll(":","");
  const visible=useMemo(()=>graphView(graph?.nodes||[],graph?.edges||[],{mode,query:search,enabled,confirmedOnly,focusId:focus?selectedId:null}),[graph,mode,search,enabled,confirmedOnly,focus,selectedId]);
  const layout=useMemo(()=>layoutGraph(visible.nodes,visible.edges),[visible]);
  const layoutKey=`${mode}:${visible.nodes.map(node=>node.id).join("|")}:${visible.edges.map(edge=>edge.id).join("|")}`;
  const fitted=useMemo(()=>fitGraph(layout),[layout]);
  const view=viewport?.key===layoutKey?viewport:fitted;
  const selected=visible.nodes.find(node=>node.id===selectedId)||null;
  const related=selected?visible.edges.filter(edge=>edge.source===selected.id||edge.target===selected.id):[];
  const neighbors=new Set(related.flatMap(edge=>[edge.source,edge.target]));
  const nodeById=new Map((graph?.nodes||[]).map(node=>[node.id,node]));
  const searchResults=(graph?.nodes||[]).filter(node=>visible.matches.has(node.id));
  function choose(id:string,narrow=false){
    const node=nodeById.get(id);if(!node)return;
    if(node.kind==="table"&&mode==="semantic")setMode("mapping");
    if(!["table","object"].includes(node.kind)&&mode==="mapping")setMode("semantic");
    setEnabled(current=>({...current,[node.kind]:true}));setSelectedId(id);setSearch("");setFocus(narrow);
  }
  function changeMode(value:Mode){setMode(value);setSelectedId(null);setFocus(false);setViewport(null);}
  function zoom(factor:number){setViewport({key:layoutKey,...zoomGraph(view,view.scale*factor)});}
  function reset(){setViewport({key:layoutKey,...fitted});}
  function pointerDown(event:ReactPointerEvent<SVGSVGElement>){
    if(event.button!==0)return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current={point:canvasPoint(event.currentTarget,event.clientX,event.clientY),view};
  }
  function pointerMove(event:ReactPointerEvent<SVGSVGElement>){
    const origin=drag.current;if(!origin)return;
    const point=canvasPoint(event.currentTarget,event.clientX,event.clientY);
    setViewport({key:layoutKey,...origin.view,x:origin.view.x+point.x-origin.point.x,y:origin.view.y+point.y-origin.point.y});
  }
  function pointerUp(event:ReactPointerEvent<SVGSVGElement>){drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}
  useEffect(()=>{
    const canvas=svgRef.current;if(!canvas)return;
    const wheel=(event:WheelEvent)=>{
      if(!event.ctrlKey&&!event.metaKey)return;
      event.preventDefault();
      setViewport({key:layoutKey,...zoomGraph(view,view.scale*Math.exp(-event.deltaY*.003),canvasPoint(canvas,event.clientX,event.clientY))});
    };
    canvas.addEventListener("wheel",wheel,{passive:false});
    return()=>canvas.removeEventListener("wheel",wheel);
  },[layoutKey,view]);
  const nodeTypes=kinds.filter(kind=>mode==="all"||(mode==="mapping"?["object","table"].includes(kind):kind!=="table"));

  return <div className="content sub-page og-page">
    <div className="og-heading"><div><h1>本体图谱</h1><p>{source?`${source.name} · ${graph?.stats.schemaVersion?`本体 v${graph.stats.schemaVersion}`:"尚未发布本体"}`:"请先选择数据源"}</p></div><div className="og-stats"><span><b>{graph?.stats.objects||0}</b>业务对象</span><span><b>{graph?.stats.tables||0}</b>数据表</span><span><b>{graph?.stats.semanticLinks||0}</b>业务关系</span></div></div>
    {!graph?.nodes.length?<div className="og-empty"><Icon name="graph" size={38}/><h2>构建本体后，在这里查看关系</h2><p>选择数据表并完成本体构建，即可浏览业务对象及其数据映射。</p><button className="primary-button" onClick={()=>onNavigate("sources")}>前往数据源与本体</button></div>:<>
      <div className="og-toolbar"><div className="og-modes" aria-label="图谱视图">{([['semantic','业务视图'],['mapping','数据映射'],['all','完整图谱']] as const).map(([value,label])=><button key={value} className={mode===value?"active":""} aria-pressed={mode===value} onClick={()=>changeMode(value)}>{label}</button>)}</div><label className="og-search"><Icon name="search" size={17}/><input aria-label="搜索图谱节点" placeholder="搜索对象、属性或数据表" value={search} onChange={event=>{setSearch(event.target.value);setFocus(false);}}/>{search&&<button aria-label="清空图谱搜索" onClick={()=>setSearch("")}><Icon name="close" size={14}/></button>}</label><button className={`og-focus ${focus?"active":""}`} disabled={!selected} aria-pressed={focus} onClick={()=>setFocus(!focus)}><Icon name="target" size={16}/>{focus?"显示全部关系":"只看相关"}</button></div>
      <div className="og-workspace"><section className="og-surface">
        <div className="og-canvas-heading"><div className="og-type-filters" aria-label="节点类型筛选">{nodeTypes.map(kind=><button key={kind} className={enabled[kind]===false?"disabled":""} aria-pressed={enabled[kind]!==false} onClick={()=>setEnabled({...enabled,[kind]:enabled[kind]===false})}><i className={`og-dot ${kind}`}/>{kindLabel[kind]}</button>)}</div>{mode!=="semantic"&&<label className="og-confirmed"><input type="checkbox" checked={confirmedOnly} onChange={event=>setConfirmedOnly(event.target.checked)}/>已确认关联</label>}</div>
        <div className="og-canvas-wrap"><svg ref={svgRef} className="og-canvas" role="group" aria-label={`本体图谱，${visible.nodes.length} 个节点、${visible.edges.length} 条关系`} viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={()=>{drag.current=null;}}>
          <defs><marker id={`${markerId}-arrow`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="#8daba4" strokeWidth="1.5"/></marker></defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>{visible.edges.map((edge,index)=><GraphEdge key={edge.id} edge={edge} positions={layout.positions} selected={Boolean(selected)} highlighted={related.includes(edge)} markerId={markerId} offset={index%3-1}/>)}{visible.nodes.map(node=><GraphNode key={node.id} node={node} position={layout.positions.get(node.id)!} selected={selected?.id===node.id} dimmed={Boolean(selected&&selected.id!==node.id&&!neighbors.has(node.id))} matched={Boolean(search.trim()&&visible.matches.has(node.id))} onSelect={()=>choose(node.id,focus)}/>)}</g>
        </svg>{!visible.nodes.length&&<div className="og-no-result"><Icon name="search" size={28}/><strong>没有匹配的节点</strong><button className="text-button" onClick={()=>{setSearch("");setEnabled({});setFocus(false);}}>清除筛选</button></div>}<div className="og-zoom"><button aria-label="缩小图谱" onClick={()=>zoom(1/1.2)}>−</button><span>{Math.round(view.scale*100)}%</span><button aria-label="放大图谱" onClick={()=>zoom(1.2)}>＋</button><i/><button aria-label="适应画布" title="适应画布" onClick={reset}><Icon name="target" size={17}/></button></div></div>
        <div className="og-canvas-footer"><span>{visible.nodes.length} 个节点 · {visible.edges.length} 条关系{search.trim()?` · 命中 ${visible.matches.size} 个` :""}</span><span>拖动平移 · Ctrl / ⌘ + 滚轮缩放</span></div>
      </section><aside className="og-inspector" aria-label="图谱详情">
        {selected?<>
          <div className="og-inspector-heading"><span><i className={`og-dot ${selected.kind}`}/>{kindLabel[selected.kind]}</span><button aria-label="关闭节点详情" onClick={()=>{setSelectedId(null);setFocus(false);}}><Icon name="close" size={16}/></button></div><h2>{selected.title}</h2><p className="og-subtitle">{selected.subtitle}</p><p className="og-description">{selected.content||"暂无业务说明"}</p>
          {selected.properties?.length?<details className="og-detail-section" open><summary>对象属性 <b>{selected.properties.length}</b></summary><div className="og-properties">{selected.properties.map(property=><div key={property.apiName}><span><strong>{property.displayName}</strong><small>{property.type}{property.inherited?" · 继承":""}</small></span><code>{property.mapping.table}.{property.mapping.column}</code></div>)}</div></details>:null}
          <details className="og-detail-section" open><summary>直接关系 <b>{related.length}</b></summary><div className="og-connections">{related.map(edge=>{const targetId=edge.source===selected.id?edge.target:edge.source;const target=nodeById.get(targetId);return target?<button key={edge.id} onClick={()=>choose(targetId,true)}><i className={`og-dot ${target.kind}`}/><span><strong>{target.title}</strong><small>{edgeLabel[edge.kind]} · {edge.source===selected.id?edge.forwardLabel||edge.label:edge.inverseLabel||edge.label}</small></span><Icon name="arrow" size={14}/></button>:null;})}{!related.length&&<p>当前视图没有直接关联。</p>}</div></details>
          {selected.tables.length>0&&<details className="og-detail-section"><summary>对应数据表 <b>{selected.tables.length}</b></summary><div className="og-table-links">{selected.tables.map(table=><button key={table} disabled={!nodeById.has(`table:${table}`)} onClick={()=>choose(`table:${table}`,true)}>{table}<Icon name="arrow" size={12}/></button>)}</div></details>}
          <button className="secondary-button og-detail-action" onClick={()=>onNavigate(["object","table"].includes(selected.kind)?"sources":"knowledge")}>{["object","table"].includes(selected.kind)?"前往数据源与本体":"查看业务知识"}<Icon name="arrow" size={14}/></button>
        </>:<>
          <div className="og-inspector-heading"><span>{search.trim()?"搜索结果":"浏览对象"}</span><small>{searchResults.length} 项</small></div><p className="og-description">{search.trim()?"搜索结果保留直接关联，点击节点可聚焦查看。":"选择一个对象，查看它的属性与直接关系。"}</p><div className="og-node-index">{searchResults.map(node=><button key={node.id} onClick={()=>choose(node.id,true)}><i className={`og-dot ${node.kind}`}/><span><strong>{node.title}</strong><small>{kindLabel[node.kind]}{node.properties?.length?` · ${node.properties.length} 个属性`:""}</small></span><Icon name="arrow" size={14}/></button>)}</div>
        </>}
      </aside></div>
    </>}
  </div>;
}

function canvasPoint(canvas:SVGSVGElement,x:number,y:number){const point=canvas.createSVGPoint();point.x=x;point.y=y;const matrix=canvas.getScreenCTM();return matrix?point.matrixTransform(matrix.inverse()):{x,y};}
function GraphNode({node,position,selected,dimmed,matched,onSelect}:{node:OntologyGraphNode;position:{x:number;y:number};selected:boolean;dimmed:boolean;matched:boolean;onSelect:()=>void}) {
  const title=truncate(node.title,25);const subtitle=node.kind==="object"?`${node.properties?.length||0} 个属性 · ${node.tables.length} 张表`:node.kind==="table"?truncate(node.content||"数据表",30):node.verified?"已生效知识":"草稿";
  return <g className={`og-node ${node.kind} ${selected?"selected":""} ${dimmed?"dimmed":""} ${matched?"matched":""}`} transform={`translate(${position.x} ${position.y})`} role="button" tabIndex={0} aria-label={`${kindLabel[node.kind]}：${node.title}`} aria-pressed={selected} onPointerDown={event=>event.stopPropagation()} onClick={onSelect} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect();}}}><rect className="og-node-body" width={NODE.width} height={NODE.height} rx="12"/><rect className="og-node-mark" x="14" y="16" width="29" height="29" rx="8"/><text className="og-node-glyph" x="28.5" y="36" textAnchor="middle">{node.kind==="object"?"◇":node.kind==="table"?"▤":node.kind==="metric"?"Σ":node.kind==="rule"?"✓":"词"}</text><text className="og-node-title" x="53" y="32">{title}</text><text className="og-node-subtitle" x="16" y="61">{subtitle}</text><title>{node.title}{node.content?`：${node.content}`:""}</title></g>;
}
function GraphEdge({edge,positions,selected,highlighted,markerId,offset}:{edge:OntologyGraphEdge;positions:Map<string,{x:number;y:number}>;selected:boolean;highlighted:boolean;markerId:string;offset:number}) {
  const a=positions.get(edge.source),b=positions.get(edge.target);if(!a||!b)return null;
  const ax=a.x+NODE.width/2,ay=a.y+NODE.height/2,bx=b.x+NODE.width/2,by=b.y+NODE.height/2;
  const horizontal=Math.abs(bx-ax)>NODE.width;
  let x1=ax,y1=ay,x2=bx,y2=by,d="";
  if(edge.source===edge.target){x1=a.x+NODE.width;y1=ay;x2=ax;y2=a.y;d=`M ${x1} ${y1} C ${x1+64} ${y1-86}, ${x2} ${y2-72}, ${x2} ${y2}`;}
  else if(horizontal){const sign=Math.sign(bx-ax);x1+=sign*NODE.width/2;x2-=sign*NODE.width/2;const bend=Math.max(40,Math.abs(x2-x1)*.5)+offset*12;d=`M ${x1} ${y1} C ${x1+sign*bend} ${y1}, ${x2-sign*bend} ${y2}, ${x2} ${y2}`;}
  else {const sign=Math.sign(by-ay)||1;y1+=sign*NODE.height/2;y2-=sign*NODE.height/2;const bend=Math.max(28,Math.abs(y2-y1)*.5);d=`M ${x1} ${y1} C ${x1+offset*20} ${y1+sign*bend}, ${x2+offset*20} ${y2-sign*bend}, ${x2} ${y2}`;}
  return <g className={`og-edge ${edge.kind} ${edge.confirmed?"":"candidate"} ${selected&&!highlighted?"dimmed":""} ${highlighted?"highlighted":""}`}><path d={d} markerEnd={`url(#${markerId}-arrow)`}/>{highlighted&&<text x={(x1+x2)/2} y={(y1+y2)/2-7} textAnchor="middle">{truncate(edge.forwardLabel||edge.label,27)}</text>}<title>{edgeLabel[edge.kind]}：{edge.label}</title></g>;
}
function truncate(value:string,units:number){let count=0,result="";for(const char of value){count+=char.charCodeAt(0)>255?1.7:1;if(count>units)return `${result}…`;result+=char;}return result;}
