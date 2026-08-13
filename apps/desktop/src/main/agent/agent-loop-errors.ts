export class AgentLoopAlreadyActiveError extends Error {
  readonly code = "AGENT_LOOP_ALREADY_ACTIVE";

  constructor(caseId: string) {
    super(`An Agent run is already active for case ${caseId}`);
    this.name = "AgentLoopAlreadyActiveError";
  }
}

export class AgentLoopStateError extends Error {
  readonly code = "AGENT_LOOP_STATE";

  constructor(message: string) {
    super(message);
    this.name = "AgentLoopStateError";
  }
}

export class AgentLoopClockError extends Error {
  readonly code = "AGENT_LOOP_CLOCK";

  constructor() {
    super("The Agent loop monotonic clock moved backward");
    this.name = "AgentLoopClockError";
  }
}

export class AgentToolPolicyError extends Error {
  readonly code = "AGENT_TOOL_POLICY";

  constructor(message: string) {
    super(message);
    this.name = "AgentToolPolicyError";
  }
}
