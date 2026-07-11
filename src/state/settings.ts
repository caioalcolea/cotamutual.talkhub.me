/**
 * Toggles do painel: liga/desliga dos bots por canal e por grupo.
 *
 * Regras:
 *   - Cotações: padrao LIGADO.
 *   - Compra (execucao): padrao SEMPRE DESLIGADO — ativacao apenas manual
 *     pelo painel. Nao existe caminho automatico que ligue este toggle.
 *
 * Resolucao efetiva: override do grupo > override do canal > padrao.
 * Persistencia em JSON (DATA_DIR/settings.json), escrita atomica.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";

export type Feature = "quotes" | "buy";

export const FEATURE_DEFAULTS: Record<Feature, boolean> = {
  quotes: true,
  buy: false, // padrao SEMPRE desligado; ativacao manual no painel
};

interface FeatureOverrides {
  quotes?: boolean;
  buy?: boolean;
}

interface GroupEntry extends FeatureOverrides {
  label?: string;
  lastSeenAt?: string;
}

interface SettingsFile {
  channels: Record<string, FeatureOverrides>;
  groups: Record<string, GroupEntry>;
}

export interface EffectiveToggles {
  quotes: boolean;
  buy: boolean;
  quotesSource: "group" | "channel" | "default";
  buySource: "group" | "channel" | "default";
}

function groupKey(channel: string, groupId: string): string {
  return `${String(channel).toLowerCase()}|${String(groupId).trim()}`;
}

export class SettingsStore {
  private data: SettingsFile = { channels: {}, groups: {} };
  private readonly filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "settings.json");
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SettingsFile>;
      this.data = {
        channels: parsed.channels ?? {},
        groups: parsed.groups ?? {},
      };
    } catch {
      // Arquivo ausente ou invalido: comeca vazio (padroes se aplicam).
      this.data = { channels: {}, groups: {} };
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  getEffective(channel: string, groupId: string): EffectiveToggles {
    const channelEntry = this.data.channels[String(channel).toLowerCase()] ?? {};
    const groupEntry = this.data.groups[groupKey(channel, groupId)] ?? {};

    const resolve = (
      feature: Feature,
    ): { value: boolean; source: "group" | "channel" | "default" } => {
      if (typeof groupEntry[feature] === "boolean") {
        return { value: groupEntry[feature] as boolean, source: "group" };
      }
      if (typeof channelEntry[feature] === "boolean") {
        return { value: channelEntry[feature] as boolean, source: "channel" };
      }
      return { value: FEATURE_DEFAULTS[feature], source: "default" };
    };

    const quotes = resolve("quotes");
    const buy = resolve("buy");
    return {
      quotes: quotes.value,
      buy: buy.value,
      quotesSource: quotes.source,
      buySource: buy.source,
    };
  }

  setChannelToggle(channel: string, feature: Feature, enabled: boolean): void {
    const key = String(channel).toLowerCase();
    this.data.channels[key] = { ...this.data.channels[key], [feature]: enabled };
    this.persist();
    logger.info("Toggle de canal atualizado", { channel: key, feature, enabled });
  }

  setGroupToggle(channel: string, groupId: string, feature: Feature, enabled: boolean): void {
    const key = groupKey(channel, groupId);
    this.data.groups[key] = { ...this.data.groups[key], [feature]: enabled };
    this.persist();
    logger.info("Toggle de grupo atualizado", { group: key, feature, enabled });
  }

  /** Remove o override do grupo (volta a herdar do canal/padrao). */
  clearGroupToggle(channel: string, groupId: string, feature: Feature): void {
    const key = groupKey(channel, groupId);
    const entry = this.data.groups[key];
    if (entry) {
      delete entry[feature];
      this.persist();
    }
  }

  /** Registra grupo visto via webhook (aparece no painel mesmo sem merchant). */
  touchGroup(channel: string, groupId: string, label?: string): void {
    const key = groupKey(channel, groupId);
    const entry = this.data.groups[key] ?? {};
    entry.lastSeenAt = new Date().toISOString();
    if (label && !entry.label) entry.label = label;
    this.data.groups[key] = entry;
    this.persist();
  }

  listChannels(): Record<string, FeatureOverrides> {
    return this.data.channels;
  }

  listGroups(): Record<string, GroupEntry> {
    return this.data.groups;
  }
}
