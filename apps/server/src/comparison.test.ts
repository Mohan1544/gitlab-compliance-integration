import { describe, expect, it } from "vitest";
import { compareEvidence } from "./comparison.js";
import { ruleMatch } from "./rules.js";
import type { Evidence, RuleFact } from "./types.js";

const project = { id: 1, name: "p", webUrl: "https://gitlab.com/example/p", visibility: "private", emptyRepo: false, reportedDefaultBranch: "main" };

function protectedMain(rules: RuleFact[], overrides: Partial<Evidence> = {}): Evidence {
  return { project, branch: { name: "main", protected: true }, rules, classification: "protected", ...overrides };
}

const mainRule = (overrides: Partial<RuleFact> = {}): RuleFact => ({
  name: "main", allowForcePush: false, codeOwnerApprovalRequired: false,
  pushAccessLevels: [{ accessLevel: 40, accessLevelDescription: "Maintainers" }],
  mergeAccessLevels: [{ accessLevel: 30, accessLevelDescription: "Developers + Maintainers" }, { userId: 7, accessLevel: 30, accessLevelDescription: "Ada" }],
  unprotectAccessLevels: [],
  ...overrides,
});

describe("rule matching", () => {
  it("matches exact names and GitLab-style wildcards, treating other characters literally", () => {
    expect(ruleMatch("main", "main")).toBe("exact");
    expect(ruleMatch("ma*", "main")).toBe("wildcard");
    expect(ruleMatch("*", "release/1.0")).toBe("wildcard");
    expect(ruleMatch("release/*", "release/1.0")).toBe("wildcard");
    expect(ruleMatch("release.1", "releaseX1")).toBeNull();
    expect(ruleMatch("mai", "main")).toBeNull();
    expect(ruleMatch("*-stable", "main")).toBeNull();
  });
});

describe("evidence comparison", () => {
  it("ignores access-entry order and display-only descriptions", () => {
    const before = protectedMain([mainRule()]);
    const after = protectedMain([mainRule({
      mergeAccessLevels: [{ userId: 7, accessLevel: 30, accessLevelDescription: "Ada Lovelace (renamed)" }, { accessLevel: 30 }],
    })]);
    expect(compareEvidence(before, after)).toEqual({ changes: [], notCompared: [] });
  });

  it("reports individual rule-field changes with readable access levels", () => {
    const before = protectedMain([mainRule()]);
    const after = protectedMain([mainRule({ allowForcePush: true, pushAccessLevels: [{ accessLevel: 30 }] })]);
    expect(compareEvidence(before, after).changes).toEqual([
      { field: "allow_force_push", rule: "main (exact)", before: false, after: true },
      { field: "push_access_levels", rule: "main (exact)", before: ["Maintainers (40)"], after: ["Developers + Maintainers (30)"] },
    ]);
  });

  it("detects changes to wildcard rules that apply to the default branch and ignores unrelated rules", () => {
    const unrelated = mainRule({ name: "release/*", allowForcePush: false });
    const before = protectedMain([mainRule({ name: "ma*" }), unrelated]);
    const after = protectedMain([mainRule({ name: "ma*", allowForcePush: true }), { ...unrelated, allowForcePush: true }]);
    expect(compareEvidence(before, after).changes).toEqual([
      { field: "allow_force_push", rule: "ma* (wildcard)", before: false, after: true },
    ]);
  });

  it("reports an applicable rule being added or removed", () => {
    const before = protectedMain([mainRule()]);
    const after = protectedMain([mainRule(), mainRule({ name: "*" })]);
    expect(compareEvidence(before, after).changes).toEqual([
      { field: "applicable_rule", rule: "* (wildcard)", before: "not present", after: "present" },
    ]);
  });

  it("treats a rule field GitLab stopped (or started) returning as not compared, never as a changed setting", () => {
    const before = protectedMain([mainRule()]);
    const after = protectedMain([mainRule({ codeOwnerApprovalRequired: undefined, allowForcePush: true })]);
    expect(compareEvidence(before, after)).toEqual({
      changes: [{ field: "allow_force_push", rule: "main (exact)", before: false, after: true }],
      notCompared: ["code_owner_approval_required (rule main (exact))"],
    });
    expect(compareEvidence(after, before)).toEqual({
      changes: [{ field: "allow_force_push", rule: "main (exact)", before: true, after: false }],
      notCompared: ["code_owner_approval_required (rule main (exact))"],
    });
    const omittedBoth = protectedMain([mainRule({ unprotectAccessLevels: undefined })]);
    expect(compareEvidence(omittedBoth, omittedBoth)).toEqual({ changes: [],
      notCompared: ["unprotect_access_levels (rule main (exact))"] });
  });

  it("compares observed empty access lists and false values without treating them as unknown", () => {
    const before = protectedMain([mainRule()]);
    const after = protectedMain([mainRule({ pushAccessLevels: [], allowForcePush: true })]);
    expect(compareEvidence(before, after)).toEqual({ changes: [
      { field: "allow_force_push", rule: "main (exact)", before: false, after: true },
      { field: "push_access_levels", rule: "main (exact)", before: ["Maintainers (40)"], after: [] },
    ], notCompared: [] });
  });

  it("compares only observed facts when the current evidence is partial", () => {
    const before = protectedMain([mainRule()]);
    const after: Evidence = { project, branch: { name: "main", protected: false }, classification: "unprotected" };
    expect(compareEvidence(before, after)).toEqual({
      changes: [
        { field: "classification", before: "protected", after: "unprotected" },
        { field: "protected", before: true, after: false },
      ],
      notCompared: ["protection_rules"],
    });
    expect(compareEvidence(before, { project }).notCompared).toEqual(["classification", "default_branch", "protected", "protection_rules"]);
  });

  it("treats an empty repository becoming initialized as explicit transitions", () => {
    const empty: Evidence = { project: { ...project, emptyRepo: true }, branchNames: [], classification: "empty" };
    const after = protectedMain([mainRule()]);
    expect(compareEvidence(empty, after).changes).toEqual([
      { field: "classification", before: "empty", after: "protected" },
      { field: "default_branch", before: null, after: "main" },
      { field: "protected", before: null, after: true },
      { field: "applicable_rule", rule: "main (exact)", before: "not present", after: "present" },
    ]);
  });

  it("reports a visibility change", () => {
    const before = protectedMain([mainRule()]);
    const after = protectedMain([mainRule()], { project: { ...project, visibility: "public" } });
    expect(compareEvidence(before, after).changes).toEqual([{ field: "visibility", before: "private", after: "public" }]);
  });
});
