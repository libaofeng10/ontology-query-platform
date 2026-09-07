import type { OntologyGraphNode, OntologyGraphEdge } from "./types";
export const GRAPH_NODE:{width:number;height:number};
export const GRAPH_VIEW:{width:number;height:number};
export type GraphTransform={x:number;y:number;scale:number};
export function graphView(nodes:OntologyGraphNode[],edges:OntologyGraphEdge[],options?:{mode?:"semantic"|"mapping"|"all";query?:string;enabled?:Partial<Record<OntologyGraphNode["kind"],boolean>>;confirmedOnly?:boolean;focusId?:string|null}):{nodes:OntologyGraphNode[];edges:OntologyGraphEdge[];matches:Set<string>};
export function layoutGraph(nodes:OntologyGraphNode[],edges:OntologyGraphEdge[]):{positions:Map<string,{x:number;y:number}>;width:number;height:number};
export function fitGraph(bounds:{width:number;height:number},view?:{width:number;height:number}):GraphTransform;
export function zoomGraph(view:GraphTransform,nextScale:number,point?:{x:number;y:number}):GraphTransform;
