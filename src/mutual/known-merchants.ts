/**
 * Catalogo semente de merchants conhecidos.
 *
 * A listagem `GET /api/v2/resource/merchants` pode recusar o service token
 * ("Service token not accepted on this endpoint"). Nao existe endpoint publico
 * de merchant por ID (`/merchants/{id}` responde 404), mas o endpoint de FEES
 * POR MERCHANT continua funcionando — ele e usado como sonda: se responde, o
 * merchant existe e esta acessivel com as credenciais atuais.
 *
 * Fontes de IDs, combinadas (sem duplicar):
 *   1. este catalogo semente (IDs e nomes ja observados em producao);
 *   2. MUTUAL_KNOWN_MERCHANT_IDS (lista separada por virgula no .env);
 *   3. snapshot em disco — todo merchant ja visto fica registrado.
 *
 * Sao apenas identificadores de organizacao (nao sao segredos).
 */

export interface KnownMerchant {
  id: string;
  legalName: string;
}

export const DEFAULT_KNOWN_MERCHANTS: readonly KnownMerchant[] = [
  { id: "org_3DXaWmcAaguU8rn2ryheTS2kRdw", legalName: "Nivaldeir Santana da Silva" },
  { id: "org_3DXbbv7UYzbxJdfNPkShMIZFRUL", legalName: "QA LTDA" },
  { id: "org_3G8ynOqchbFQnpR34OWQ0zwDA8k", legalName: "VIZZO SOLUCOES EM PAGAMENTOS LTDA" },
  { id: "org_3DlCeZ9n23OixBfrLIguS5IYHCr", legalName: "AURE B2B LTDA" },
  { id: "org_3GCB1ejLJncliHCeH5zrn8qZMxA", legalName: "GHC INTERMEDIACAO E GESTAO LTDA" },
  { id: "org_3GAFdOrABIIMwp3WSN3aKC6akwG", legalName: "Soluções Financeiras Digitais" },
  { id: "d582c552-ef54-4570-85db-21b52b7b37cf", legalName: "cangs hodler ltda" },
  { id: "org_3Gs8676PudsHsdVrdQ54mJuPncz", legalName: "CANGS HODLER LTDA" },
  { id: "org_3GVLabz4J4BjaTaXZpuVVpMXOs1", legalName: "ofertas ltda" },
  { id: "org_3GQDHBpM2NybFJ55xfvpyHaRUqu", legalName: "59.215.470 CALVIN DA COSTA SOARES" },
  { id: "org_3GHDyUf3xsvfgH4IDLUos9dLhIX", legalName: "RAZÃO SOCIAL" },
  { id: "org_3GH8gny4TPrH1uqdGlxnI2eBQur", legalName: "65.088.005 Gustavo Franca Brandao" },
  { id: "org_3GEGaBdXye7j21oXjAlvDkWax9w", legalName: "MOVE4 MARKETING E PUBLICIDADE LTDA" },
  { id: "org_3GCvWGz1eoT2QyLX3D4dYsGtL2m", legalName: "Vitoria delalibera Barbosa" },
  { id: "org_3GCnIYtwfvdb7FIm4m9s5TlOCvO", legalName: "Aurepay Game" },
  { id: "org_3GCmiWpNgYzfWqmMQYHQzG5p8UU", legalName: "Aurepay Info" },
  { id: "org_3GCmPalEHZmdMuT0R66YKIgLhLt", legalName: "Aurepay Finance" },
  { id: "org_3GBuCikNBTxGju1t1giKJ8n1K1G", legalName: "ROYAL CREST JOGOS E APOSTAS - BRASIL LTDA" },
  { id: "org_3GBgc68gXJJc1FpRhiip2pt2yAm", legalName: "Pedro lucas da Silva Lucena" },
  { id: "org_3GBfN6ISTKghe0xgk5EoeplSOGc", legalName: "Paguebit Serviços Digitais Ltda" },
  { id: "org_3GBHhEzVOdmQOoydbmcGyrAxYB8", legalName: "ICON ASSET MANAGEMENT CORP. LTDA" },
  { id: "org_3FxXQkMFb7N5FHXKRjxpa5iBGyh", legalName: "DIGITO SOLUCOES FINANCEIRAS LTDA" },
  { id: "org_3DuSGekNRwOVBryD2J3nisnePTX", legalName: "E-BOOK'S RJ CORPORE LTDA" },
  { id: "org_3DaAw2fdwmvXUWYNkeqhNh5avFJ", legalName: "MUTUAL CAPITAL TECNOLOGIA FINANCEIRA" },
  { id: "org_3Da2LLhwtVLCc4Qo4GekohevidV", legalName: "Easy pay" },
];

export const DEFAULT_KNOWN_MERCHANT_IDS: readonly string[] = DEFAULT_KNOWN_MERCHANTS.map(
  (m) => m.id,
);

/** Nome conhecido de um ID (quando a API nao devolve o cadastro completo). */
export function knownMerchantName(id: string): string | null {
  return DEFAULT_KNOWN_MERCHANTS.find((m) => m.id === id)?.legalName ?? null;
}

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
