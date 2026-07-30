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
  /**
   * Forma canonica do grupo: JID (...@g.us) quando o convite ja foi resolvido
   * na Evolution; caso contrario, o proprio link/codigo de convite (o
   * GroupMatcher resolve na hora da mensagem).
   */
  groupId: string;
  merchantId: string;
  label?: string;
  /** Link/codigo de convite digitado pelo operador, quando foi essa a entrada. */
  invite?: string;
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

  bindGroup(
    channel: string,
    groupId: string,
    merchantId: string,
    label?: string,
    invite?: string | null,
  ): GroupBinding {
    const binding: GroupBinding = {
      channel: String(channel).toLowerCase(),
      groupId: String(groupId).trim(),
      merchantId: String(merchantId).trim(),
      label,
      ...(invite ? { invite: String(invite).trim() } : {}),
      boundAt: new Date().toISOString(),
    };
    // Ao vincular pelo JID ja resolvido, remove um vinculo antigo que tenha
    // ficado gravado pelo link de convite (evita duplicar o mesmo grupo).
    if (invite && String(invite).trim() !== binding.groupId) {
      this.removeBinding(binding.channel, String(invite).trim());
    }
    this.data.bindings = {
      ...this.data.bindings,
      [MerchantStore.bindingKey(binding.channel, binding.groupId)]: binding,
    };
    this.rememberIds([binding.merchantId]);
    this.persist();
    logger.info("Grupo vinculado manualmente a um merchant", binding as unknown as Record<string, unknown>);
    return binding;
  }

  /** Remove sem persistir; retorna true se havia vinculo. */
  private removeBinding(channel: string, groupId: string): boolean {
    const key = MerchantStore.bindingKey(channel, groupId);
    if (!this.data.bindings?.[key]) return false;
    delete this.data.bindings[key];
    return true;
  }

  /**
   * Remove o vinculo do grupo. `aliases` cobre as duas formas do mesmo grupo
   * (JID e link/codigo de convite): o operador desvincula digitando qualquer
   * uma delas.
   */
  unbindGroup(channel: string, groupId: string, ...aliases: (string | null | undefined)[]): boolean {
    const targets = [groupId, ...aliases]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);

    let removed = false;
    for (const target of targets) {
      if (this.removeBinding(channel, target)) removed = true;
    }
    // Tambem remove o vinculo cujo convite gravado bata com o que foi digitado.
    for (const [key, binding] of Object.entries(this.data.bindings ?? {})) {
      if (
        binding.channel === String(channel).toLowerCase() &&
        binding.invite &&
        targets.includes(binding.invite)
      ) {
        delete this.data.bindings[key];
        removed = true;
      }
    }

    if (removed) {
      this.persist();
      logger.info("Vínculo manual removido", { channel, groupId });
    }
    return removed;
  }
}
