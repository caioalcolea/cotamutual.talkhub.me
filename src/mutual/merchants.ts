/**
 * Endpoints de recursos (sempre em PRODUCAO, conforme validacao do projeto):
 *   GET /api/v2/resource/merchants                      (listagem)
 *   GET /api/v2/resource/merchants/{merchantId}         (individual — fallback)
 *   GET /api/v2/resource/fees/merchant/{merchantId}     (fees)
 *
 * A listagem pode recusar o service token ("Service token not accepted on this
 * endpoint"). Quando isso acontece, o sistema consulta merchant a merchant
 * pelos IDs conhecidos — os endpoints por organizacao seguem funcionando.
 */

import axios from "axios";
import type { MutualClients } from "./client.js";
import type {
  MutualFee,
  MutualFeesResponse,
  MutualMerchant,
  MutualMerchantsResponse,
} from "../types.js";
import { describeError } from "../util/errors.js";
import { logger } from "../logger.js";

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

/** Caminhos tentados na consulta individual, na ordem. */
const MERCHANT_BY_ID_PATHS = [
  (id: string) => `/api/v2/resource/merchants/${encodeURIComponent(id)}`,
  (id: string) => `/api/v2/resource/merchants/organization/${encodeURIComponent(id)}`,
];

/** Extrai o merchant de respostas no formato {data: {...}}, {data:[...]} ou objeto direto. */
function extractMerchant(payload: unknown, id: string): MutualMerchant | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const data = body.data ?? body;
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== "object") return null;
  const merchant = candidate as MutualMerchant;
  if (!merchant.id) merchant.id = id;
  return merchant;
}

/**
 * Consulta UM merchant pelo ID da organizacao. `pathTemplate` (opcional)
 * permite corrigir o caminho por variavel de ambiente sem novo build:
 * use "{id}" como marcador.
 */
export async function fetchMerchantById(
  clients: MutualClients,
  id: string,
  pathTemplate?: string | null,
): Promise<MutualMerchant | null> {
  const builders = pathTemplate
    ? [(value: string) => pathTemplate.replace("{id}", encodeURIComponent(value))]
    : MERCHANT_BY_ID_PATHS;

  let lastError: unknown = null;
  for (const build of builders) {
    const path = build(id);
    try {
      const response = await clients.prod.get(path);
      const merchant = extractMerchant(response.data, id);
      if (merchant) return merchant;
    } catch (error) {
      lastError = error;
      // 404 = caminho errado para esta API: tenta o proximo formato.
      if (axios.isAxiosError(error) && error.response?.status === 404) continue;
      // Demais erros (401/5xx) nao melhoram trocando o caminho.
      break;
    }
  }
  if (lastError) {
    logger.warn("Falha ao consultar merchant individual", {
      merchantId: id,
      detail: describeError(lastError),
    });
  }
  return null;
}

export interface IndividualFetchResult {
  merchants: MutualMerchant[];
  failed: string[];
}

/**
 * Consulta os merchants um a um (em fila), respeitando a concorrencia
 * configurada. Retorna o que conseguiu — uma lista parcial e melhor do que
 * nenhuma, e os IDs que falharam ficam registrados.
 */
export async function fetchMerchantsByIds(
  clients: MutualClients,
  ids: readonly string[],
  concurrency = 1,
  pathTemplate?: string | null,
): Promise<IndividualFetchResult> {
  const merchants: MutualMerchant[] = [];
  const failed: string[] = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, ids.length || 1)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= ids.length) return;
      const id = ids[index];
      const merchant = await fetchMerchantById(clients, id, pathTemplate);
      if (merchant) merchants.push(merchant);
      else failed.push(id);
    }
  });

  await Promise.all(workers);
  return { merchants, failed };
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
