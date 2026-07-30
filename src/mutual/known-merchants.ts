/**
 * Catalogo semente de merchants conhecidos.
 *
 * A listagem `GET /api/v2/resource/merchants` pode recusar o service token
 * ("Service token not accepted on this endpoint"). Os endpoints POR
 * ORGANIZACAO continuam funcionando, entao o sistema consulta merchant a
 * merchant usando os IDs conhecidos.
 *
 * Fontes de IDs, combinadas (sem duplicar):
 *   1. este catalogo semente (IDs ja observados em producao);
 *   2. MUTUAL_KNOWN_MERCHANT_IDS (lista separada por virgula no .env);
 *   3. snapshot em disco — todo merchant ja visto fica registrado.
 *
 * Sao apenas identificadores de organizacao (nao sao segredos).
 */

export const DEFAULT_KNOWN_MERCHANT_IDS: readonly string[] = [
  "org_3DXaWmcAaguU8rn2ryheTS2kRdw", // Nivaldeir Santana da Silva
  "org_3DXbbv7UYzbxJdfNPkShMIZFRUL", // QA LTDA
  "org_3G8ynOqchbFQnpR34OWQ0zwDA8k", // VIZZO SOLUCOES EM PAGAMENTOS LTDA
  "org_3DlCeZ9n23OixBfrLIguS5IYHCr", // AURE B2B LTDA
  "org_3GCB1ejLJncliHCeH5zrn8qZMxA", // GHC INTERMEDIACAO E GESTAO LTDA
  "org_3GAFdOrABIIMwp3WSN3aKC6akwG", // Solucoes Financeiras Digitais
  "d582c552-ef54-4570-85db-21b52b7b37cf", // cangs hodler ltda
  "org_3Gs8676PudsHsdVrdQ54mJuPncz", // CANGS HODLER LTDA
  "org_3GVLabz4J4BjaTaXZpuVVpMXOs1", // ofertas ltda
  "org_3GQDHBpM2NybFJ55xfvpyHaRUqu", // 59.215.470 CALVIN DA COSTA SOARES
  "org_3GHDyUf3xsvfgH4IDLUos9dLhIX", // RAZAO SOCIAL
  "org_3GH8gny4TPrH1uqdGlxnI2eBQur", // 65.088.005 Gustavo Franca Brandao
  "org_3GEGaBdXye7j21oXjAlvDkWax9w", // MOVE4 MARKETING E PUBLICIDADE LTDA
  "org_3GCvWGz1eoT2QyLX3D4dYsGtL2m", // Vitoria delalibera Barbosa
  "org_3GCnIYtwfvdb7FIm4m9s5TlOCvO", // Aurepay Game
  "org_3GCmiWpNgYzfWqmMQYHQzG5p8UU", // Aurepay Info
  "org_3GCmPalEHZmdMuT0R66YKIgLhLt", // Aurepay Finance
  "org_3GBuCikNBTxGju1t1giKJ8n1K1G", // ROYAL CREST JOGOS E APOSTAS
  "org_3GBgc68gXJJc1FpRhiip2pt2yAm", // Pedro lucas da Silva Lucena
  "org_3GBfN6ISTKghe0xgk5EoeplSOGc", // Paguebit Servicos Digitais Ltda
  "org_3GBHhEzVOdmQOoydbmcGyrAxYB8", // ICON ASSET MANAGEMENT CORP. LTDA
  "org_3FxXQkMFb7N5FHXKRjxpa5iBGyh", // DIGITO SOLUCOES FINANCEIRAS LTDA
  "org_3DuSGekNRwOVBryD2J3nisnePTX", // E-BOOK'S RJ CORPORE LTDA
  "org_3DaAw2fdwmvXUWYNkeqhNh5avFJ", // MUTUAL CAPITAL TECNOLOGIA FINANCEIRA
  "org_3Da2LLhwtVLCc4Qo4GekohevidV", // Easy pay
];

/** Normaliza e deduplica uma lista de IDs vinda de varias fontes. */
export function mergeMerchantIds(...sources: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources) {
    for (const raw of source) {
      const id = String(raw || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
