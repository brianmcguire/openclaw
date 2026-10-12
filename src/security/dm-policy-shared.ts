import { expectDefined } from "@openclaw/normalization-core";
// Shares direct-message policy normalization for channel audits.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveChannelIngressEffectiveAllowFromLists as resolveEffectiveAllowFromLists } from "../channels/message-access/effective-allow-from.js";

/**
 * Derive a stable main-DM owner from a single-entry allowlist.
 * Wildcards, multi-owner lists, and non-main DM scopes stay unpinned so callers keep route-specific sessions.
 */
export function resolvePinnedMainDmOwnerFromAllowlist(params: {
  dmScope?: string | null;
  allowFrom?: Array<string | number> | null;
  normalizeEntry: (entry: string) => string | undefined;
}): string | null {
  if ((params.dmScope ?? "main") !== "main") {
    return null;
  }
  const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
  if (rawAllowFrom.some((entry) => String(entry).trim() === "*")) {
    return null;
  }
  const normalizedOwners = Array.from(
    new Set(
      rawAllowFrom
        .map((entry) => params.normalizeEntry(String(entry)))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  return normalizedOwners.length === 1
    ? expectDefined(normalizedOwners[0], "normalized owners entry at 0")
    : null;
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export { resolveEffectiveAllowFromLists };

/** Admission decision returned by legacy DM/group access helpers. */
export type DmGroupAccessDecision = "allow" | "block" | "pairing";

/** Stable reason codes used by channel plugins, command auth, and diagnostics. */
export const DM_GROUP_ACCESS_REASON = {
  GROUP_POLICY_ALLOWED: "group_policy_allowed",
  GROUP_POLICY_DISABLED: "group_policy_disabled",
  GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
  GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
  DM_POLICY_OPEN: "dm_policy_open",
  DM_POLICY_DISABLED: "dm_policy_disabled",
  DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
  DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
  DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted",
} as const;
/** Machine-readable reason code for a DM/group access decision. */
export type DmGroupAccessReasonCode =
  (typeof DM_GROUP_ACCESS_REASON)[keyof typeof DM_GROUP_ACCESS_REASON];
type DmGroupAccessResult = {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
};

const dmGroupAccess = (
  decision: DmGroupAccessDecision,
  reasonCode: DmGroupAccessReasonCode,
  reason: string,
): DmGroupAccessResult => ({ decision, reasonCode, reason });

/**
 * Resolve sender access for `dmPolicy=open`, where `*` means fully open and a configured
 * allowlist still restricts the accepted sender set.
 *
 * @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`.
 */
export function resolveOpenDmAllowlistAccess(params: {
  effectiveAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): DmGroupAccessResult {
  const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
  return effectiveAllowFrom.includes("*")
    ? dmGroupAccess("allow", DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN, "dmPolicy=open")
    : params.isSenderAllowed(effectiveAllowFrom)
      ? dmGroupAccess(
          "allow",
          DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
          "dmPolicy=open (allowlisted)",
        )
      : dmGroupAccess(
          "block",
          DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
          "dmPolicy=open (not allowlisted)",
        );
}

/** @deprecated Use `resolveChannelMessageIngress` or `readChannelIngressStoreAllowFromForDmPolicy` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export { readChannelIngressStoreAllowFromForDmPolicy as readStoreAllowFromForDmPolicy } from "../channels/message-access/store-allow-from.js";
