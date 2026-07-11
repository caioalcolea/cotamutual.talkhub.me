/**
 * Endpoints de recursos (sempre em PRODUCAO, conforme validacao do projeto):
 *   GET /api/v2/resource/merchants
 *   GET /api/v2/resource/fees/merchant/{merchantId}
 */

import type { MutualClients } from "./client.js";
import type {
  MutualFee,
  MutualFeesResponse,
  MutualMerchant,
  MutualMerchantsResponse,
} from "../types.js";

export async function fetchMerchantsPage(
  clients: MutualClients,
  page: number,
  limit: number,
): Promise<MutualMerchantsResponse> {
  const response = await clients.prod.get<MutualMerchantsResponse>(
    "/api/v2/resource/merchants",
    { params: { page, limit } },
  );
  return response.data;
}

/** Busca TODOS os merchants seguindo a paginacao (limit 100 por pagina). */
export async function fetchAllMerchants(clients: MutualClients): Promise<MutualMerchant[]> {
  const all: MutualMerchant[] = [];
  let page = 1;
  // Limite de seguranca de 50 paginas (5.000 merchants).
  for (let i = 0; i < 50; i += 1) {
    const response = await fetchMerchantsPage(clients, page, 100);
    all.push(...(response.data ?? []));
    if (!response.pagination?.hasNextPage) break;
    page += 1;
  }
  return all;
}

export async function fetchMerchantFees(
  clients: MutualClients,
  merchantId: string,
): Promise<MutualFee[]> {
  const response = await clients.prod.get<MutualFeesResponse>(
    `/api/v2/resource/fees/merchant/${encodeURIComponent(merchantId)}`,
  );
  return response.data.data ?? [];
}
