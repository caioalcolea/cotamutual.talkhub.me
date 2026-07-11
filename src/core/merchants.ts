/**
 * Identificacao do merchant pelo grupo (secao 4 do descritivo).
 *
 * Criterios:
 *   linkGroup.channel === channel (case-insensitive)
 *   linkGroup.groupId === groupId (trim)
 *   linkGroup.active === true
 *   merchant.status === "active"
 */

import type { MutualMerchant } from "../types.js";

export function findMerchantByGroup(
  merchants: MutualMerchant[],
  channel: string,
  groupId: string,
): MutualMerchant | undefined {
  const normalizedChannel = String(channel || "").toLowerCase();
  const normalizedGroupId = String(groupId || "").trim();

  return merchants.find((merchant) => {
    if (merchant.status !== "active") {
      return false;
    }
    return (merchant.linkGroups || []).some((group) => {
      return (
        group.active === true &&
        String(group.channel || "").toLowerCase() === normalizedChannel &&
        String(group.groupId || "").trim() === normalizedGroupId
      );
    });
  });
}
