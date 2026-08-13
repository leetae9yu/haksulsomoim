export function agentGoal(goal: "civil" | "criminal", caseId: string) {
  return goal === "civil"
    ? ({
        kind: "civil-recovery" as const,
        caseId,
        objective: "prepare-civil-demand" as const,
      } as const)
    : ({
        kind: "criminal-complaint" as const,
        caseId,
        objective: "prepare-criminal-complaint" as const,
      } as const);
}
