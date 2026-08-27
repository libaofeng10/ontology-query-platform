import type { KnowledgePage } from "./types";

export declare const KNOWLEDGE_PAGE_TYPES: readonly ["term", "metric", "join", "rule", "table"];
export declare function coverageByType(pages: KnowledgePage[] | null | undefined): Record<"term" | "metric" | "join" | "rule" | "table", { total: number; verified: number }>;
export declare function missingAssetLines(missingAssets: Array<{ kind: string; label: string }> | null | undefined): Array<{ kind: string; label: string; text: string }>;
