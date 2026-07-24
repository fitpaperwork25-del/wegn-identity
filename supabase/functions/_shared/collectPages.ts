export async function collectAllPages<T>(params: {
  pageSize: number;
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: unknown | null }>;
}): Promise<{ data: T[] | null; error: unknown | null }> {
  if (!Number.isInteger(params.pageSize) || params.pageSize < 1) {
    return { data: null, error: new Error("invalid_page_size") };
  }
  const all: T[] = [];
  for (let from = 0; ; from += params.pageSize) {
    const result = await params.fetchPage(from, from + params.pageSize - 1);
    if (result.error) return { data: null, error: result.error };
    const page = result.data ?? [];
    all.push(...page);
    if (page.length < params.pageSize) return { data: all, error: null };
  }
}
