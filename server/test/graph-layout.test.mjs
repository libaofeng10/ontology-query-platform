import assert from "node:assert/strict";
import test from "node:test";
import { graphView, layoutGraph, fitGraph, zoomGraph, GRAPH_NODE, GRAPH_VIEW } from "../../app/graph-layout.mjs";

const node=(id,kind="object")=>({id,kind,title:id,subtitle:"",content:"",tables:[]});
const edge=(source,target,kind="semantic",confirmed=true)=>({id:`${source}:${target}:${kind}`,source,target,kind,confirmed});

test("large cyclic and disconnected graphs keep every visible node separated and inside fitted bounds",()=>{
  const nodes=Array.from({length:85},(_,i)=>node(`object-${i}`));
  const edges=Array.from({length:64},(_,i)=>edge("object-0",`object-${i+1}`));
  for(let i=1;i<35;i++)edges.push(edge(`object-${i}`,`object-${i+1}`));
  edges.push(edge("object-1","object-1"));
  const layout=layoutGraph(nodes,edges);assert.equal(layout.positions.size,nodes.length);
  const positions=[...layout.positions.values()];
  for(const a of positions){assert.ok(a.x>=0&&a.y>=0);assert.ok(a.x+GRAPH_NODE.width<=layout.width);assert.ok(a.y+GRAPH_NODE.height<=layout.height);}
  for(let i=0;i<positions.length;i++)for(let j=i+1;j<positions.length;j++){
    const a=positions[i],b=positions[j];assert.ok(a.x+GRAPH_NODE.width<=b.x||b.x+GRAPH_NODE.width<=a.x||a.y+GRAPH_NODE.height<=b.y||b.y+GRAPH_NODE.height<=a.y,`nodes ${i} and ${j} overlap`);
  }
  const view=fitGraph(layout);assert.ok(view.x>=0&&view.y>=0);assert.ok(layout.width*view.scale+view.x<=GRAPH_VIEW.width);assert.ok(layout.height*view.scale+view.y<=GRAPH_VIEW.height);
  assert.deepEqual(layoutGraph([...nodes].reverse(),[...edges].reverse()),layout,"backend row order must not reshuffle the layout");
});

test("search and focus retain direct relationships without pulling unrelated or hidden nodes",()=>{
  const nodes=[node("customer"),node("order"),node("invoice"),node("unrelated"),node("table:customer","table")];
  const edges=[edge("customer","order"),edge("order","invoice"),edge("customer","table:customer","mapping")];
  const searched=graphView(nodes,edges,{query:"customer"});
  assert.deepEqual(searched.nodes.map(node=>node.id),["customer","order"]);assert.equal(searched.edges.length,1);assert.deepEqual([...searched.matches],["customer"]);
  const hidden=graphView(nodes,edges,{mode:"mapping",enabled:{table:false},focusId:"customer"});assert.deepEqual(hidden.nodes.map(node=>node.id),["customer"]);
  const mapping=graphView(nodes,edges,{mode:"mapping"});assert.ok(mapping.nodes.some(node=>node.kind==="table"));assert.ok(mapping.edges.every(edge=>edge.kind==="mapping"));
  assert.equal(graphView(nodes,edges,{query:"not found"}).nodes.length,0);
});

test("confirmed filtering only affects physical joins and search leaves all matching neighbors",()=>{
  const nodes=[node("a","table"),node("b","table"),node("c","table"),node("term","term")];
  const edges=[edge("a","b","join",true),edge("a","c","join",false),edge("a","term","binding",false)];
  const view=graphView(nodes,edges,{mode:"all",query:"a",confirmedOnly:true});
  assert.deepEqual(view.nodes.map(node=>node.id),["a","b","term"]);assert.equal(view.edges.length,2);
});

test("zoom keeps the pointer's graph coordinate fixed, with valid transforms for empty data",()=>{
  const initial={x:73,y:-40,scale:.4};const point={x:317,y:208};
  const next=zoomGraph(initial,.9,point);
  assert.ok(Math.abs((point.x-initial.x)/initial.scale-(point.x-next.x)/next.scale)<1e-8);
  assert.ok(Math.abs((point.y-initial.y)/initial.scale-(point.y-next.y)/next.scale)<1e-8);
  const empty=fitGraph(layoutGraph([],[]));assert.ok(Object.values(empty).every(Number.isFinite));
});
