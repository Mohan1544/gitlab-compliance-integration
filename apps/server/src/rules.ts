import type { RuleFact } from "./types.js";

export type RuleMatch = "exact" | "wildcard";

// GitLab protected-branch names may contain `*`, which matches any sequence of characters (including `/`).
export function ruleMatch(ruleName: string, branchName: string): RuleMatch | null {
  if (ruleName === branchName) return "exact";
  if (!ruleName.includes("*")) return null;
  const pattern = ruleName.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${pattern}$`).test(branchName) ? "wildcard" : null;
}

export function applicableRules(rules: RuleFact[], branchName: string): { rule: RuleFact; match: RuleMatch }[] {
  return rules.flatMap((rule) => {
    const match = ruleMatch(rule.name, branchName);
    return match ? [{ rule, match }] : [];
  });
}
