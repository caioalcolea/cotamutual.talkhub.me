/**
 * Snapshot em disco dos merchants.
 *
 * Serve a dois propositos:
 *   1. lembrar os IDs de organizacao ja vistos, para a consulta individual
 *      (fallback quando a listagem recusa o service token);
 *   2. ultimo estado valido — se a listagem E a consulta individual falharem,
 *      os grupos continuam resolvendo pelo snapshot (com aviso de data).
 *
 * Gravacao atomica em DATA_DIR/merchants-snapshot.json.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MutualMerchant } from "../types.js";
import { logger } from "../logger.js";

/** Vinculo manual grupo -> merchant, definido no painel. */
export interface GroupBinding {
  channel: string;
  groupId: string;
  merchantId: string;
  label?: string;
  boundAt: string;
}

interface SnapshotFile {
  savedAt: string;
  merchants: MutualMerchant[];
  knownIds: string[];
  /** Chave: "canal|groupId". */
  bindings: Record<string, GroupBinding>;
}

export class MerchantStore {
  private readonly filePath: string;
  private data: SnapshotFile = { savedAt: "", merchants: [], knownIds: [], bindings: {} };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "merchants-snapshot.json");
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<SnapshotFile>;
      this.data = {
        savedAt: parsed.savedAt ?? "",
        merchants: parsed.merchants ?? [],
        knownIds: parsed.knownIds ?? [],
        bindings: parsed.bindings ?? {},
      };
      logger.info("Snapshot de merchants carregado", {
        count: this.data.merchants.length,
        savedAt: this.data.savedAt || null,
      });
    } catch {
      this.data = { savedAt: "", merchants: [], knownIds: [], bindings: {} };
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.filePath);
    } catch (error) {
      logger.error("Falha ao gravar snapshot de merchants", { error: String(error) });
    }
  }

  merchants(): MutualMerchant[] {
    return this.data.merchants;
  }

  savedAt(): string | null {
    return this.data.savedAt || null;
  }

  knownIds(): string[] {
    return this.data.knownIds;
  }

  /** Registra o resultado de uma consulta bem-sucedida (lista ou parcial). */
  save(merchants: MutualMerchant[]): void {
    if (merchants.length === 0) return;
    const ids = new Set(this.data.knownIds);
    for (const merchant of merchants) {
      if (merchant.id) ids.add(merchant.id);
    }
    this.data = {
      ...this.data,
      savedAt: new Date().toISOString(),
      merchants,
      knownIds: [...ids],
    };
    this.persist();
  }

  /** Guarda IDs descobertos sem sobrescrever o snapshot de merchants. */
  rememberIds(ids: readonly string[]): void {
    const set = new Set(this.data.knownIds);
    let changed = false;
    for (const raw of ids) {
      const id = String(raw || "").trim();
      if (id && !set.has(id)) {
        set.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.data.knownIds = [...set];
      this.persist();
    }
  }

  // -------------------------------------------------------------------------
  // Vinculos manuais grupo -> merchant (painel)
  //
  // Enquanto a listagem de merchants estiver indisponivel, os linkGroups da
  // Mutual nao chegam. O operador vincula o grupo ao merchant pelo painel e o
  // sistema passa a cotar normalmente. O vinculo tambem serve para grupos
  // ainda nao cadastrados na Mutual.
  // -------------------------------------------------------------------------

  private static bindingKey(channel: string, groupId: string): string {
    return `${String(channel).toLowerCase()}|${String(groupId).trim()}`;
  }

  bindings(): GroupBinding[] {
    return Object.values(this.data.bindings ?? {});
  }

  bindGroup(channel: string, groupId: string, merchantId: string, label?: string): GroupBinding {
    const binding: GroupBinding = {
      channel: String(channel).toLowerCase(),
      groupId: String(groupId).trim(),
      merchantId: String(merchantId).trim(),
      label,
      boundAt: new Date().toISOString(),
    };
    this.data.bindings = { ...this.data.bindings, [MerchantStore.bindingKey(channel, groupId)]: binding };
    this.rememberIds([binding.merchantId]);
    this.persist();
    logger.info("Grupo vinculado manualmente a um merchant", binding as unknown as Record<string, unknown>);
    return binding;
  }

  unbindGroup(channel: string, groupId: string): void {
    const key = MerchantStore.bindingKey(channel, groupId);
    if (this.data.bindings?.[key]) {
      delete this.data.bindings[key];
      this.persist();
      logger.info("Vínculo manual removido", { channel, groupId });
    }
  }
}
