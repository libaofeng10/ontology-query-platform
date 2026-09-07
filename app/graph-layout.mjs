export const GRAPH_NODE={width:248,height:78};
export const GRAPH_VIEW={width:1200,height:720};

export function graphView(nodes,edges,{mode="semantic",query="",enabled={},confirmedOnly=false,focusId=null}={}) {
  const nodeAllowed=kind=>mode==="all"||(mode==="mapping"?["object","table"].includes(kind):kind!=="table");
  const edgeAllowed=kind=>mode==="all"||(mode==="mapping"?["mapping","join"].includes(kind):["semantic","subclass","binding","wikilink"].includes(kind));
  const allowed=new Set(nodes.filter(node=>enabled[node.kind]!==false&&nodeAllowed(node.kind)).map(node=>node.id));
  const links=edges.filter(edge=>allowed.has(edge.source)&&allowed.has(edge.target)&&edgeAllowed(edge.kind)&&(!confirmedOnly||edge.kind!=="join"||edge.confirmed));
  const needle=query.trim().toLowerCase();
  const matches=new Set(nodes.filter(node=>allowed.has(node.id)&&`${node.title} ${node.subtitle} ${node.content} ${node.tables.join(" ")} ${(node.properties||[]).map(property=>`${property.apiName} ${property.displayName}`).join(" ")}`.toLowerCase().includes(needle)).map(node=>node.id));
  let included=allowed;
  if(needle||focusId&&allowed.has(focusId)) {
    const anchors=focusId&&allowed.has(focusId)?new Set([focusId]):matches;
    included=new Set(anchors);
    for(const edge of links)if(anchors.has(edge.source)||anchors.has(edge.target)){included.add(edge.source);included.add(edge.target);}
  }
  return {nodes:nodes.filter(node=>included.has(node.id)),edges:links.filter(edge=>included.has(edge.source)&&included.has(edge.target)),matches};
}

// Lay out the visible relationship components, rather than placing every kind
// in fixed lanes. Each level reserves its actual size, including disconnected
// components, so large catalogs cannot overwrite another lane or leave viewBox.
export function layoutGraph(nodes,edges) {
  const positions=new Map();
  if(!nodes.length)return {positions,width:GRAPH_VIEW.width,height:GRAPH_VIEW.height};
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const adjacent=new Map(nodes.map(node=>[node.id,new Set()]));
  for(const edge of edges)if(adjacent.has(edge.source)&&adjacent.has(edge.target)&&edge.source!==edge.target){adjacent.get(edge.source).add(edge.target);adjacent.get(edge.target).add(edge.source);}
  const compare=(a,b)=>(byId.get(b).kind==="object")-(byId.get(a).kind==="object")||adjacent.get(b).size-adjacent.get(a).size||a.localeCompare(b,"en");
  const remaining=new Set([...byId.keys()].sort(compare));const components=[];
  while(remaining.size) {
    const root=[...remaining][0];const levels=[];const queue=[[root,0]];remaining.delete(root);
    for(let cursor=0;cursor<queue.length;cursor++) {
      const [id,depth]=queue[cursor];(levels[depth]??=[]).push(id);
      for(const neighbor of [...adjacent.get(id)].sort(compare))if(remaining.delete(neighbor))queue.push([neighbor,depth+1]);
    }
    const local=new Map();let x=0;const height=Math.max(...levels.map(level=>Math.min(6,level.length)*(GRAPH_NODE.height+40)-40));
    for(const level of levels) {
      const rows=Math.min(6,level.length);const columns=Math.ceil(level.length/rows);
      const top=(height-(rows*(GRAPH_NODE.height+40)-40))/2;
      level.forEach((id,index)=>local.set(id,{x:x+Math.floor(index/rows)*(GRAPH_NODE.width+44),y:top+(index%rows)*(GRAPH_NODE.height+40)}));
      x+=columns*(GRAPH_NODE.width+44)+64;
    }
    components.push({local,width:x-108,height,count:queue.length});
  }
  const targetWidth=Math.max(GRAPH_VIEW.width,Math.sqrt(nodes.length)*320);let x=48,y=48,rowHeight=0,width=0;
  for(const component of components) {
    if(x>48&&x+component.width>targetWidth){x=48;y+=rowHeight+96;rowHeight=0;}
    for(const [id,position] of component.local)positions.set(id,{x:x+position.x,y:y+position.y});
    width=Math.max(width,x+component.width+48);rowHeight=Math.max(rowHeight,component.height);x+=component.width+96;
  }
  return {positions,width,height:y+rowHeight+48};
}

export function fitGraph(bounds,view=GRAPH_VIEW) {
  const scale=Math.min(1.15,(view.width-64)/Math.max(1,bounds.width),(view.height-64)/Math.max(1,bounds.height));
  return {scale,x:(view.width-bounds.width*scale)/2,y:(view.height-bounds.height*scale)/2};
}
export function zoomGraph(view,nextScale,point={x:GRAPH_VIEW.width/2,y:GRAPH_VIEW.height/2}) {
  const scale=Math.max(.04,Math.min(2.5,nextScale));const ratio=scale/view.scale;
  return {scale,x:point.x-(point.x-view.x)*ratio,y:point.y-(point.y-view.y)*ratio};
}
