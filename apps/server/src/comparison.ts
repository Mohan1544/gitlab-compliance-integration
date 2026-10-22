import { applicableRules } from "./rules.js";
import type { AccessLevelFact, Evidence } from "./types.js";

export interface Change {
  field: string;
  rule?: string;
  before: unknown;
  after: unknown;
}

export interface EvidenceComparison {
  changes: Change[];
  // Facts the current evidence did not observe, so no change (or absence of change) is claimed for them.
  notCompared: string[];
}

interface RuleFacts {
  label: string;
  allowForcePush?: boolean;
  codeOwnerApprovalRequired?: boolean;
  pushAccessLevels?: string[];
  mergeAccessLevels?: string[];
  unprotectAccessLevels?: string[];
}

// `undefined` means "not observed"; `null` means "observed as not existing".
interface PostureFacts {
  visibility: string;
  classification?: string;
  defaultBranch?: string | null;
  protected?: boolean | null;
  rules?: Map<string, RuleFacts>;
}

const LEVEL_NAMES: Record<number, string> = { 0: "No one", 30: "Developers + Maintainers", 40: "Maintainers", 60: "Admins" };

// Identity of an access entry only. Provider record IDs and display text (access_level_description) are ignored,
// so renaming a user or group is not reported as a protection change.
function levelKey(level: AccessLevelFact): string {
  if (level.userId !== undefined) return `user ${level.userId}`;
  if (level.groupId !== undefined) return `group ${level.groupId}`;
  if (level.deployKeyId !== undefined) return `deploy key ${level.deployKeyId}`;
  if (level.accessLevel !== undefined) return `${LEVEL_NAMES[level.accessLevel] ?? "Access level"} (${level.accessLevel})`;
  return "unspecified entry";
}

function normalizeLevels(levels: AccessLevelFact[] | undefined): string[] | undefined {
  return levels ? [...new Set(levels.map(levelKey))].sort() : undefined;
}

function postureFacts(evidence: Evidence): PostureFacts {
  const facts: PostureFacts = { visibility: evidence.project.visibility, classification: evidence.classification };
  if (evidence.classification === "empty") {
    return { ...facts, defaultBranch: null, protected: null, rules: new Map() };
  }
  if (evidence.branch) {
    facts.defaultBranch = evidence.branch.name;
    facts.protected = evidence.branch.protected;
    if (evidence.rules) {
      facts.rules = new Map(applicableRules(evidence.rules, evidence.branch.name).map(({ rule, match }) => [rule.name, {
        label: `${rule.name} (${match})`,
        allowForcePush: rule.allowForcePush,
        codeOwnerApprovalRequired: rule.codeOwnerApprovalRequired,
        pushAccessLevels: normalizeLevels(rule.pushAccessLevels),
        mergeAccessLevels: normalizeLevels(rule.mergeAccessLevels),
        unprotectAccessLevels: normalizeLevels(rule.unprotectAccessLevels),
      }]));
    }
  }
  return facts;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function compareEvidence(before: Evidence, after: Evidence): EvidenceComparison {
  const prior = postureFacts(before);
  const current = postureFacts(after);
  const changes: Change[] = [];
  const notCompared: string[] = [];
  const scalars: [string, unknown, unknown][] = [
    ["visibility", prior.visibility, current.visibility],
    ["classification", prior.classification, current.classification],
    ["default_branch", prior.defaultBranch, current.defaultBranch],
    ["protected", prior.protected, current.protected],
  ];
  for (const [field, left, right] of scalars) {
    if (left === undefined || right === undefined) notCompared.push(field);
    else if (!same(left, right)) changes.push({ field, before: left, after: right });
  }

  if (!prior.rules || !current.rules) {
    notCompared.push("protection_rules");
    return { changes, notCompared };
  }
  const names = [...new Set([...prior.rules.keys(), ...current.rules.keys()])].sort();
  for (const name of names) {
    const left = prior.rules.get(name);
    const right = current.rules.get(name);
    if (!left || !right) {
      changes.push({ field: "applicable_rule", rule: (left ?? right)!.label, before: left ? "present" : "not present", after: right ? "present" : "not present" });
      continue;
    }
    const fields: [string, unknown, unknown][] = [
      ["allow_force_push", left.allowForcePush, right.allowForcePush],
      ["code_owner_approval_required", left.codeOwnerApprovalRequired, right.codeOwnerApprovalRequired],
      ["push_access_levels", left.pushAccessLevels, right.pushAccessLevels],
      ["merge_access_levels", left.mergeAccessLevels, right.mergeAccessLevels],
      ["unprotect_access_levels", left.unprotectAccessLevels, right.unprotectAccessLevels],
    ];
    for (const [field, beforeValue, afterValue] of fields) {
      // A field GitLab omitted on either side is unknown there: losing (or gaining) visibility of a setting
      // does not prove its value changed, so it is listed as not compared rather than reported as a change.
      if (beforeValue === undefined || afterValue === undefined) {
        notCompared.push(`${field} (rule ${right.label})`);
      } else if (!same(beforeValue, afterValue)) {
        changes.push({ field, rule: right.label, before: beforeValue, after: afterValue });
      }
    }
  }
  return { changes, notCompared };
}
