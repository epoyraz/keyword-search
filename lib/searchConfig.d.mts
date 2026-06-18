export const SEARCH_FIELDS: string[];
export function tokenize(text: string): string[];
export function processTerm(term: string): string | null;
export const SEARCH_OPTIONS: {
  boost: Record<string, number>;
  prefix: boolean;
  fuzzy: number;
  combineWith: "AND" | "OR";
};
export function miniSearchOptions(): {
  idField: string;
  fields: string[];
  tokenize: (text: string) => string[];
  processTerm: (term: string) => string | null;
  searchOptions: typeof SEARCH_OPTIONS;
};
