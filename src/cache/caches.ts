/**
 * Cache de merchants e fees.
 *
 * - Merchants: TTL padrao 60s, com TRES niveis de obtencao.
 * - Fees:      TTL padrao 60s, por merchant.
 * - Cotacoes:  NUNCA passam por aqui — cada mensagem da fila faz requisicao nova.
 *
 * Niveis de obtencao dos merchants (o primeiro que funcionar vence):
 *   1. LISTAGEM   GET /api/v2/resource/merchants
 *   2. INDIVIDUAL consulta em fila, um a um, pelos IDs conhecidos — usado
 *      quando a listagem falha (ex: "Service token not accepted on this
 *      endpoint"); os endpoints por organizacao seguem funcionando
 *   3. SNAPSHOT   ultimo estado valido gravado em disco
 *
 * Falhas ficam registradas (lastError) para o painel mostrar o motivo real em
 * vez de uma lista vazia sem explicacao.
 */

import type { MutualClients } from "../mutual/client.js";
import { fetchAllMerchants, fetchMerchantFees, fetchMerchantsByIds } from "../mutual/merchants.js";
import { DEFAULT_KNOWN_MERCHANT_IDS, mergeMerchantIds } from "../mutual/known-merchants.js";
import type { MerchantStore } from "../state/merchant-store.js";
import type { MutualFee, MutualMerchant } from "../types.js";
import { describeError } from "../util/errors.js";
import { logger } from "../logger.js";

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

export interface CacheFailure {
  detail: string;
  at: number;
}

/** De onde veio a lista de merchants em uso. */
export type MerchantSource = "listing" | "individual" | "snapshot";

export interface MerchantCacheOptions {
  store?: MerchantStore | null;
  /** Consulta individual quando a listagem falha. */
  fallbackEnabled?: boolean;
  /** Quantas consultas individuais em paralelo (padrao 1 = uma a uma). */
  fallbackConcurrency?: number;
  /** IDs extras vindos do .env. */
  extraIds?: readonly string[];
  /** Caminho alternativo do endpoint individual ("{id}" como marcador). */
  merchantByIdPath?: string | null;
}

export class MerchantCache {
  private entry: CacheEntry<MutualMerchant[]> | null = null;
  private pending: Promise<MutualMerchant[]> | null = null;
  private failure: CacheFailure | null = null;
  private source: MerchantSource | null = null;
  private lastFallbackFailedIds: string[] = [];
  /** IDs que nao existem nesta conta: reconsultados so a cada 10 minutos. */
  private readonly deadIds = new Map<string, number>();

  private readonly store: MerchantStore | null;
  private readonly fallbackEnabled: boolean;
  private readonly fallbackConcurrency: number;
  private readonly extraIds: readonly string[];
  private readonly merchantByIdPath: string | null;

  constructor(
    private readonly clients: MutualClients,
    private readonly ttlMs: number,
    options: MerchantCacheOptions = {},
  ) {
    this.store = options.store ?? null;
    this.fallbackEnabled = options.fallbackEnabled ?? true;
    this.fallbackConcurrency = Math.max(1, options.fallbackConcurrency ?? 1);
    this.extraIds = options.extraIds ?? [];
    this.merchantByIdPath = options.merchantByIdPath ?? null;
  }

  /** Todos os IDs conhecidos: semente + .env + snapshot. */
  knownIds(): string[] {
    return mergeMerchantIds(this.extraIds, this.store?.knownIds() ?? [], DEFAULT_KNOWN_MERCHANT_IDS);
  }

  async getAll(): Promise<MutualMerchant[]> {
    const now = Date.now();
    if (this.entry && now - this.entry.fetchedAt < this.ttlMs) {
      return this.entry.value;
    }
    if (this.pending) return this.pending;

    this.pending = this.load()
      .then((merchants) => {
        this.entry = { value: merchants, fetchedAt: Date.now() };
        return merchants;
      })
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }

  private async load(): Promise<MutualMerchant[]> {
    // ---------------- 1) Listagem ----------------
    try {
      const merchants = await fetchAllMerchants(this.clients);
      this.failure = null;
      this.source = "listing";
      this.lastFallbackFailedIds = [];
      this.store?.save(merchants);
      return merchants;
    } catch (error) {
      const detail = describeError(error);
      this.failure = { detail, at: Date.now() };
      logger.warn("Listagem de merchants indisponível; acionando consulta individual", { detail });
    }

    // ---------------- 2) Consulta individual (em fila) ----------------
    if (this.fallbackEnabled) {
      const now = Date.now();
      const DEAD_ID_RETRY_MS = 10 * 60 * 1000;
      const all = this.knownIds();
      // Evita martelar IDs inexistentes a cada ciclo; se nada sobrar, tenta todos.
      const ids = all.filter((id) => {
        const failedAt = this.deadIds.get(id);
        return !failedAt || now - failedAt > DEAD_ID_RETRY_MS;
      });
      const candidates = ids.length > 0 ? ids : all;
      if (candidates.length > 0) {
        try {
          const result = await fetchMerchantsByIds(
            this.clients,
            candidates,
            this.fallbackConcurrency,
            this.merchantByIdPath,
          );
          for (const id of result.failed) this.deadIds.set(id, Date.now());
          for (const merchant of result.merchants) this.deadIds.delete(merchant.id);
          if (result.merchants.length > 0) {
            // Preserva linkGroups do snapshot quando a resposta individual
            // nao os traz — o vinculo de grupo nao pode se perder.
            const merged = this.mergeWithSnapshot(result.merchants);
            this.source = "individual";
            this.lastFallbackFailedIds = result.failed;
            this.store?.save(merged);
            logger.info("Merchants obtidos por consulta individual", {
              count: merged.length,
              failed: result.failed.length,
            });
            return merged;
          }
          logger.warn("Consulta individual não retornou merchants", { tried: candidates.length });
          this.lastFallbackFailedIds = result.failed;
        } catch (error) {
          logger.warn("Falha na consulta individual de merchants", {
            detail: describeError(error),
          });
        }
      }
    }

    // ---------------- 3) Snapshot em disco ----------------
    const snapshot = this.store?.merchants() ?? [];
    if (snapshot.length > 0) {
      this.source = "snapshot";
      logger.warn("Usando snapshot de merchants em disco", {
        count: snapshot.length,
        savedAt: this.store?.savedAt(),
      });
      return snapshot;
    }

    // ---------------- Nada disponivel: cache anterior ou erro ----------------
    if (this.entry) {
      logger.warn("Nenhuma fonte de merchants disponível; mantendo cache anterior", {
        count: this.entry.value.length,
      });
      return this.entry.value;
    }

    logger.error("Falha ao consultar merchants na Mutual", {
      detail: this.failure?.detail ?? "sem detalhe",
    });
    throw new Error(this.failure?.detail ?? "Falha ao consultar merchants");
  }

  /** Mantem linkGroups conhecidos quando a resposta individual nao os traz. */
  private mergeWithSnapshot(merchants: MutualMerchant[]): MutualMerchant[] {
    const previous = new Map<string, MutualMerchant>();
    for (const merchant of this.store?.merchants() ?? []) {
      if (merchant.id) previous.set(merchant.id, merchant);
    }
    for (const merchant of this.entry?.value ?? []) {
      if (merchant.id && !previous.has(merchant.id)) previous.set(merchant.id, merchant);
    }

    return merchants.map((merchant) => {
      if (merchant.linkGroups && merchant.linkGroups.length > 0) return merchant;
      const old = previous.get(merchant.id);
      if (old?.linkGroups?.length) {
        return { ...merchant, linkGroups: old.linkGroups };
      }
      return merchant;
    });
  }

  /** Estado para o painel (sem forcar atualizacao). */
  snapshot(): {
    merchants: MutualMerchant[];
    fetchedAt: number | null;
    lastError: CacheFailure | null;
    source: MerchantSource | null;
    knownIdCount: number;
    fallbackFailedIds: string[];
    snapshotSavedAt: string | null;
  } {
    return {
      merchants: this.entry?.value ?? [],
      fetchedAt: this.entry?.fetchedAt ?? null,
      lastError: this.failure,
      source: this.source,
      knownIdCount: this.knownIds().length,
      fallbackFailedIds: this.lastFallbackFailedIds,
      snapshotSavedAt: this.store?.savedAt() ?? null,
    };
  }
}

export class FeeCache {
  private readonly entries = new Map<string, CacheEntry<MutualFee[]>>();
  private readonly pending = new Map<string, Promise<MutualFee[]>>();
  private failure: CacheFailure | null = null;

  constructor(
    private readonly clients: MutualClients,
    private readonly ttlMs: number,
  ) {}

  async getByMerchantId(merchantId: string): Promise<MutualFee[]> {
    const now = Date.now();
    const cached = this.entries.get(merchantId);
    if (cached && now - cached.fetchedAt < this.ttlMs) {
      return cached.value;
    }

    const inFlight = this.pending.get(merchantId);
    if (inFlight) return inFlight;

    const promise = fetchMerchantFees(this.clients, merchantId)
      .then((fees) => {
        this.entries.set(merchantId, { value: fees, fetchedAt: Date.now() });
        return fees;
      })
      .catch((error) => {
        const detail = describeError(error);
        this.failure = { detail, at: Date.now() };
        if (cached) {
          logger.warn("Falha ao atualizar fees; usando cache anterior", { merchantId, detail });
          return cached.value;
        }
        logger.error("Falha ao consultar fees na Mutual", { merchantId, detail });
        throw error;
      })
      .finally(() => {
        this.pending.delete(merchantId);
      });

    this.pending.set(merchantId, promise);
    return promise;
  }

  lastError(): CacheFailure | null {
    return this.failure;
  }
}
