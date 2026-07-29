/**
 * Execucao com concorrencia limitada.
 *
 * Buscar as fees de dezenas de merchants em paralelo dispara limite de
 * requisicoes na Mutual (429) e derruba tambem as cotacoes — as chamadas
 * compartilham a mesma API. Este helper mantem no maximo N em voo.
 */

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
