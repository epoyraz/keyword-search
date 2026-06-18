/* tslint:disable */
/* eslint-disable */

export class MiniSearchWasm {
    free(): void;
    [Symbol.dispose](): void;
    add(document: any): void;
    addAll(documents: any): void;
    addAllJSON(documents: string): void;
    discard(id: any): void;
    static loadBytes(bytes: Uint8Array): MiniSearchWasm;
    static loadJSON(serialized: string): MiniSearchWasm;
    constructor(options: any);
    remove(document: any): void;
    search(query: string, options: any): any;
    /**
     * Profiling probe: runs the search but returns only the hit count, so
     * result materialization/serialization is excluded. Lets the benchmark show
     * pure engine compute cost separately from the boundary cost.
     */
    searchCountDefault(query: string, or_mode: boolean): number;
    /**
     * Diagnostic probe: hit count for a query with prefix/fuzzy toggled, to
     * profile where search time goes.
     */
    searchCountOpts(query: string, prefix: boolean, fuzzy: boolean): number;
    /**
     * App-facing fast search and the recommended path for embedding apps. Only
     * the query string and an `orMode` flag cross the boundary (no options
     * object to deserialize); the whole search runs in Wasm against the index's
     * configured search options. The result set crosses back as just three
     * values — `scores` (a `Float64Array`, one bulk copy) plus `ids` and
     * `terms` as single newline-joined strings that JS splits natively — so
     * there is almost no per-hit object churn at the boundary.
     *
     * Shape: `{ count, ids: "id0\nid1\n…", scores: Float64Array, terms: "a b\nc\n…" }`
     * where each `terms` row is space-joined. Returns identical rankings to
     * `search()` (same ids, same BM25 scores).
     */
    searchJoined(query: string, or_mode: boolean): any;
    toBytes(): Uint8Array;
    toJSON(): any;
    toJSONString(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_minisearchwasm_free: (a: number, b: number) => void;
    readonly minisearchwasm_add: (a: number, b: any) => [number, number];
    readonly minisearchwasm_addAll: (a: number, b: any) => [number, number];
    readonly minisearchwasm_addAllJSON: (a: number, b: number, c: number) => [number, number];
    readonly minisearchwasm_discard: (a: number, b: any) => [number, number];
    readonly minisearchwasm_loadBytes: (a: number, b: number) => [number, number, number];
    readonly minisearchwasm_loadJSON: (a: number, b: number) => [number, number, number];
    readonly minisearchwasm_new: (a: any) => [number, number, number];
    readonly minisearchwasm_remove: (a: number, b: any) => [number, number];
    readonly minisearchwasm_search: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly minisearchwasm_searchCountDefault: (a: number, b: number, c: number, d: number) => number;
    readonly minisearchwasm_searchCountOpts: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly minisearchwasm_searchJoined: (a: number, b: number, c: number, d: number) => any;
    readonly minisearchwasm_toBytes: (a: number) => [number, number, number, number];
    readonly minisearchwasm_toJSON: (a: number) => [number, number, number];
    readonly minisearchwasm_toJSONString: (a: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
