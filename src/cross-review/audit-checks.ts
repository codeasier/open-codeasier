import { READ_ONLY_TOOLS, REVIEWER_AGENT } from "./tool.js";
import type {
  CrossReviewRun,
  GathererRun,
  JudgeRun,
  ReviewerRun,
} from "./run-store.js";
import type {
  AuditCheck,
  AuditMessage,
  AuditSessionEvidence,
  CheckResult,
  ProtocolCall,
} from "./audit-types.js";
import { TERMINAL_AUDIT_PHASES } from "./audit-types.js";

export function persistedContext(
  run: Pick<CrossReviewRun, "context">,
): string | undefined {
  if (run.context === undefined || run.context.length === 0) return undefined;
  return run.context;
}

export function isTerminalPhase(phase: CrossReviewRun["phase"]): boolean {
  return TERMINAL_AUDIT_PHASES.has(phase);
}

export function roleNeverDispatched(role: {
  status: string;
  startedAt?: number;
}): boolean {
  if (role.status === "queued") return true;
  return role.status === "cancelled" && role.startedAt === undefined;
}

function annotated(
  id: string,
  result: CheckResult,
  detail: string,
  extra?: { runID?: string; role?: string },
): AuditCheck {
  return {
    id,
    result,
    detail,
    ...(extra?.runID === undefined ? {} : { runID: extra.runID }),
    ...(extra?.role === undefined ? {} : { role: extra.role }),
  };
}

function modelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

function linkedMessage(
  evidence: AuditSessionEvidence | undefined,
  messageID: string,
):
  | { status: "present"; message: AuditMessage }
  | { status: "omitted" }
  | { status: "missing" } {
  if (evidence === undefined) return { status: "missing" };
  const message = evidence.messages.find((item) => item.id === messageID);
  if (message !== undefined) return { status: "present", message };
  if (evidence.truncated || evidence.omittedMessages > 0)
    return { status: "omitted" };
  return { status: "missing" };
}

export function checkRunsFound(input: {
  runCount: number;
  runIDFilter?: boolean;
}): AuditCheck {
  if (input.runCount > 0 || input.runIDFilter === true)
    return annotated(
      "runs.found",
      "pass",
      input.runCount === 1
        ? "Resolved one owner run"
        : `Found ${input.runCount} owner runs`,
    );
  return annotated(
    "runs.found",
    "fail",
    "No cross-review run manifests for this parent session",
  );
}

export function checkLegacyToolAbsent(calls: ProtocolCall[]): AuditCheck {
  const blocking = calls.filter((call) => call.name === "cross_review");
  if (blocking.length === 0)
    return annotated(
      "run.legacy_tool.absent",
      "pass",
      "Parent has no blocking cross_review tool call",
    );
  return annotated(
    "run.legacy_tool.absent",
    "fail",
    `Parent used blocking cross_review ${blocking.length} time(s)`,
  );
}

export function checkContextContract(
  run: Pick<CrossReviewRun, "judgeModel" | "context" | "gatherer" | "runID">,
): AuditCheck {
  const context = persistedContext(run);
  const extra = { runID: run.runID };
  if (run.judgeModel === undefined) {
    if (context !== undefined)
      return annotated(
        "run.context_contract",
        "pass",
        "Parent-judged run persisted non-empty context",
        extra,
      );
    return annotated(
      "run.context_contract",
      "fail",
      "No judgeModel requires persisted non-empty context",
      extra,
    );
  }
  if (context !== undefined)
    return annotated(
      "run.context_contract",
      "pass",
      "Judge run persisted non-empty context",
      extra,
    );
  if (run.gatherer !== undefined)
    return annotated(
      "run.context_contract",
      "pass",
      "Judge run without context has a gatherer",
      extra,
    );
  return annotated(
    "run.context_contract",
    "fail",
    "judgeModel without context requires a gatherer object",
    extra,
  );
}

export function checkGathererSkippedWhenContext(
  run: Pick<CrossReviewRun, "context" | "gatherer" | "runID">,
): AuditCheck {
  const extra = { runID: run.runID };
  if (persistedContext(run) === undefined)
    return annotated(
      "gatherer.skipped_when_context",
      "pass",
      "No persisted context, so gatherer skip does not apply",
      extra,
    );
  if (run.gatherer === undefined)
    return annotated(
      "gatherer.skipped_when_context",
      "pass",
      "Persisted context skipped the gatherer",
      extra,
    );
  return annotated(
    "gatherer.skipped_when_context",
    "fail",
    "Persisted context should omit the gatherer object",
    extra,
  );
}

export function checkGathererJudgeSession(
  run: Pick<CrossReviewRun, "gatherer" | "judge" | "runID">,
): AuditCheck {
  const extra = { runID: run.runID };
  if (run.gatherer === undefined || run.judge === undefined)
    return annotated(
      "gatherer.judge_session",
      "pass",
      "Gatherer and judge are not both present",
      extra,
    );
  if (
    run.gatherer.sessionID === run.judge.sessionID &&
    run.gatherer.messageID !== run.judge.messageID
  )
    return annotated(
      "gatherer.judge_session",
      "pass",
      "Gatherer and judge share a session with different message IDs",
      extra,
    );
  return annotated(
    "gatherer.judge_session",
    "fail",
    "Gatherer and judge must share a sessionID and use different messageIDs",
    extra,
  );
}

function pendingPromptResult(input: {
  inProgress: boolean;
  neverDispatched?: boolean;
}): CheckResult {
  return input.inProgress || input.neverDispatched === true
    ? "insufficient-evidence"
    : "fail";
}

function pendingPromptDetail(input: {
  inProgress: boolean;
  neverDispatched?: boolean;
}): string {
  if (input.neverDispatched === true)
    return "Role was never dispatched, so the linked user message is absent";
  if (input.inProgress) return "Linked user message is not present yet";
  return "Linked user message is missing";
}

export function checkPromptMessageID(input: {
  runID: string;
  role: string;
  messageID: string;
  evidence?: AuditSessionEvidence;
  inProgress: boolean;
  neverDispatched?: boolean;
}): AuditCheck {
  const extra = { runID: input.runID, role: input.role };
  const found = linkedMessage(input.evidence, input.messageID);
  if (found.status === "omitted")
    return annotated(
      "role.prompt.messageID",
      "insufficient-evidence",
      "Linked user message was omitted by bounds",
      extra,
    );
  if (found.status === "missing")
    return annotated(
      "role.prompt.messageID",
      pendingPromptResult(input),
      pendingPromptDetail(input),
      extra,
    );
  if (found.message.id === input.messageID)
    return annotated(
      "role.prompt.messageID",
      "pass",
      "Linked user message id matches the manifest",
      extra,
    );
  return annotated(
    "role.prompt.messageID",
    "fail",
    "Linked user message id does not match the manifest",
    extra,
  );
}

export function checkPromptModel(input: {
  runID: string;
  role: string;
  messageID: string;
  expectedModel: string;
  evidence?: AuditSessionEvidence;
  inProgress: boolean;
  neverDispatched?: boolean;
}): AuditCheck {
  const extra = { runID: input.runID, role: input.role };
  const found = linkedMessage(input.evidence, input.messageID);
  if (found.status === "omitted")
    return annotated(
      "role.prompt.model",
      "insufficient-evidence",
      "Linked user message was omitted by bounds",
      extra,
    );
  if (found.status === "missing")
    return annotated(
      "role.prompt.model",
      pendingPromptResult(input),
      pendingPromptDetail(input),
      extra,
    );
  if (found.message.model === undefined)
    return annotated(
      "role.prompt.model",
      "insufficient-evidence",
      "Linked user message omitted model fields",
      extra,
    );
  const actual = modelKey(found.message.model);
  if (actual === input.expectedModel)
    return annotated(
      "role.prompt.model",
      "pass",
      "Prompt model matches the manifest",
      extra,
    );
  return annotated(
    "role.prompt.model",
    "fail",
    `Prompt model ${actual} does not match manifest ${input.expectedModel}`,
    extra,
  );
}

export function checkToolsDeny(input: {
  runID: string;
  role: string;
  messageID: string;
  evidence?: AuditSessionEvidence;
  inProgress: boolean;
  neverDispatched?: boolean;
}): AuditCheck {
  const extra = { runID: input.runID, role: input.role };
  const found = linkedMessage(input.evidence, input.messageID);
  if (found.status === "omitted")
    return annotated(
      "role.prompt.tools_deny",
      "insufficient-evidence",
      "Linked user message was omitted by bounds",
      extra,
    );
  if (found.status === "missing")
    return annotated(
      "role.prompt.tools_deny",
      pendingPromptResult(input),
      pendingPromptDetail(input),
      extra,
    );
  if (found.message.tools === undefined)
    return annotated(
      "role.prompt.tools_deny",
      "fail",
      "Linked user message has no tools deny map",
      extra,
    );
  const missing = Object.keys(READ_ONLY_TOOLS).filter(
    (name) => found.message.tools?.[name] !== false,
  );
  if (missing.length === 0)
    return annotated(
      "role.prompt.tools_deny",
      "pass",
      "READ_ONLY_TOOLS are all denied on the linked user message",
      extra,
    );
  return annotated(
    "role.prompt.tools_deny",
    "fail",
    `Linked user message does not deny: ${missing.join(", ")}`,
    extra,
  );
}

export function checkRoleSessionLinked(input: {
  runID: string;
  role: string;
  ownerSessionID: string;
  evidence?: AuditSessionEvidence;
  messageID: string;
  neverDispatched?: boolean;
}): AuditCheck {
  const extra = { runID: input.runID, role: input.role };
  if (input.evidence === undefined)
    return annotated(
      "role.session.linked",
      input.neverDispatched === true ? "insufficient-evidence" : "fail",
      input.neverDispatched === true
        ? "Role was never dispatched and its session was not readable"
        : "Role session was not readable",
      extra,
    );
  const prefix = input.runID.slice(0, 8);
  const title = input.evidence.title ?? "";
  const roleToken =
    input.role === "gatherer"
      ? /gatherer|judge/i
      : new RegExp(input.role.replace(/:\d+$/, ""), "i");
  const titleOk = title.includes(prefix) && roleToken.test(title);
  const parentOk = input.evidence.parentID === input.ownerSessionID;
  const found = linkedMessage(input.evidence, input.messageID);
  const agent =
    found.status === "present"
      ? found.message.agent
      : input.evidence.messages.find((message) => message.role === "user")
          ?.agent;
  const agentOk = agent === REVIEWER_AGENT;
  if (parentOk && titleOk && agentOk)
    return annotated(
      "role.session.linked",
      "pass",
      "Role session is linked to the owner with a matching title and agent",
      extra,
    );
  if (found.status === "omitted" && parentOk && titleOk)
    return annotated(
      "role.session.linked",
      "insufficient-evidence",
      "Role session parent and title match, but agent was omitted",
      extra,
    );
  if (input.neverDispatched === true && parentOk && titleOk)
    return annotated(
      "role.session.linked",
      "insufficient-evidence",
      "Role session parent and title match, but the role was never prompted",
      extra,
    );
  return annotated(
    "role.session.linked",
    "fail",
    "Role session parentID, title, or agent does not match the role",
    extra,
  );
}

export function checkOrchestrationAbsent(input: {
  runID: string;
  role: string;
  evidence?: AuditSessionEvidence;
  inProgress: boolean;
  neverDispatched?: boolean;
}): AuditCheck {
  const extra = { runID: input.runID, role: input.role };
  if (input.evidence === undefined)
    return annotated(
      "role.orchestration.absent",
      pendingPromptResult(input),
      input.neverDispatched === true
        ? "Role was never dispatched and its session was not readable"
        : "Role session was not readable",
      extra,
    );
  const forbidden = input.evidence.messages.flatMap((message) =>
    message.parts.filter(
      (part) =>
        part.type === "tool" &&
        (part.name === "session_review" ||
          part.name === "cross_review_audit" ||
          part.name.startsWith("cross_review")),
    ),
  );
  if (forbidden.length > 0)
    return annotated(
      "role.orchestration.absent",
      "fail",
      `Role session called orchestration tools: ${forbidden
        .map((part) => (part.type === "tool" ? part.name : "?"))
        .join(", ")}`,
      extra,
    );
  if (input.evidence.truncated)
    return annotated(
      "role.orchestration.absent",
      "insufficient-evidence",
      "Role session omitted messages that could contain orchestration tools",
      extra,
    );
  if (input.inProgress)
    return annotated(
      "role.orchestration.absent",
      "insufficient-evidence",
      "Role session is still in progress",
      extra,
    );
  return annotated(
    "role.orchestration.absent",
    "pass",
    "Role session has no orchestration tool calls",
    extra,
  );
}

function successfulTask(evidence: AuditSessionEvidence): boolean {
  return evidence.messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === "tool" &&
        part.name === "task" &&
        part.status === "completed",
    ),
  );
}

export function checkNoChildren(input: {
  runID: string;
  role: string;
  evidence?: AuditSessionEvidence;
}): AuditCheck {
  const extra = { runID: input.runID, role: input.role };
  if (input.evidence === undefined)
    return annotated(
      "role.no_children",
      "insufficient-evidence",
      "Role session was not readable",
      extra,
    );
  if (successfulTask(input.evidence))
    return annotated(
      "role.no_children",
      "fail",
      "Role session has a successful task tool part",
      extra,
    );
  if (!input.evidence.childrenListed)
    return annotated(
      "role.no_children",
      "insufficient-evidence",
      "SDK did not list children of the role session",
      extra,
    );
  if ((input.evidence.childCount ?? 0) > 0)
    return annotated(
      "role.no_children",
      "fail",
      "Role session has child sessions",
      extra,
    );
  return annotated(
    "role.no_children",
    "pass",
    "Role session has no children and no successful task part",
    extra,
  );
}

function promptModels(evidence: AuditSessionEvidence): string[] {
  const models: string[] = [];
  for (const message of evidence.messages) {
    if (message.role !== "user" || message.model === undefined) continue;
    models.push(modelKey(message.model));
  }
  return models;
}

export function checkSilentModelReplace(input: {
  run: Pick<
    CrossReviewRun,
    "runID" | "phase" | "reviewers" | "gatherer" | "judge"
  >;
  sessions: Map<string, AuditSessionEvidence | undefined>;
}): AuditCheck {
  const extra = { runID: input.run.runID };
  const expected = new Map<string, Set<string>>();
  const add = (role: ReviewerRun | GathererRun | JudgeRun) => {
    if (roleNeverDispatched(role)) return;
    const models = expected.get(role.sessionID) ?? new Set<string>();
    models.add(role.model);
    expected.set(role.sessionID, models);
  };
  for (const reviewer of input.run.reviewers) add(reviewer);
  if (input.run.gatherer !== undefined) add(input.run.gatherer);
  if (input.run.judge !== undefined) add(input.run.judge);

  const inProgress = !isTerminalPhase(input.run.phase);
  let missingPrompt = false;
  let failed: string | undefined;
  let insufficient: string | undefined;
  for (const [sessionID, models] of expected) {
    const evidence = input.sessions.get(sessionID);
    if (evidence === undefined) {
      if (inProgress) missingPrompt = true;
      else failed = `Role session ${sessionID} was not readable`;
      continue;
    }
    if (evidence.truncated) {
      insufficient =
        "Role session omitted messages needed to compare dispatched models";
      continue;
    }
    const actual = promptModels(evidence);
    if (actual.length === 0) {
      missingPrompt = true;
      continue;
    }
    const unexpected = actual.filter((model) => !models.has(model));
    if (unexpected.length > 0)
      failed = `Dispatched model(s) not in the manifest: ${unexpected.join(", ")}`;
    for (const model of models) {
      if (!actual.includes(model)) missingPrompt = true;
    }
  }
  if (failed !== undefined)
    return annotated("run.silent_model_replace.absent", "fail", failed, extra);
  if (insufficient !== undefined)
    return annotated(
      "run.silent_model_replace.absent",
      "insufficient-evidence",
      insufficient,
      extra,
    );
  if (missingPrompt && inProgress)
    return annotated(
      "run.silent_model_replace.absent",
      "insufficient-evidence",
      "Not every role prompt has been dispatched yet",
      extra,
    );
  if (missingPrompt)
    return annotated(
      "run.silent_model_replace.absent",
      "fail",
      "A role prompt model is missing or does not match the manifest",
      extra,
    );
  return annotated(
    "run.silent_model_replace.absent",
    "pass",
    expected.size === 0
      ? "No dispatched role prompts to compare"
      : "Every role prompt model matches the manifest with no extras",
    extra,
  );
}

export function evaluateRoleChecks(input: {
  run: CrossReviewRun;
  role: string;
  messageID: string;
  model: string;
  status: string;
  startedAt?: number;
  evidence?: AuditSessionEvidence;
}): AuditCheck[] {
  const inProgress = !isTerminalPhase(input.run.phase);
  const neverDispatched = roleNeverDispatched({
    status: input.status,
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
  });
  const evidence =
    input.evidence === undefined ? {} : { evidence: input.evidence };
  const pending = neverDispatched ? { neverDispatched: true } : {};
  return [
    checkRoleSessionLinked({
      runID: input.run.runID,
      role: input.role,
      ownerSessionID: input.run.ownerSessionID,
      messageID: input.messageID,
      ...pending,
      ...evidence,
    }),
    checkPromptMessageID({
      runID: input.run.runID,
      role: input.role,
      messageID: input.messageID,
      inProgress,
      ...pending,
      ...evidence,
    }),
    checkPromptModel({
      runID: input.run.runID,
      role: input.role,
      messageID: input.messageID,
      expectedModel: input.model,
      inProgress,
      ...pending,
      ...evidence,
    }),
    checkToolsDeny({
      runID: input.run.runID,
      role: input.role,
      messageID: input.messageID,
      inProgress,
      ...pending,
      ...evidence,
    }),
    checkOrchestrationAbsent({
      runID: input.run.runID,
      role: input.role,
      inProgress,
      ...pending,
      ...evidence,
    }),
    checkNoChildren({
      runID: input.run.runID,
      role: input.role,
      ...evidence,
    }),
  ];
}

export function evaluateRunChecks(input: {
  run: CrossReviewRun;
  sessions: Map<string, AuditSessionEvidence | undefined>;
}): AuditCheck[] {
  const checks = [
    checkContextContract(input.run),
    checkSilentModelReplace({ run: input.run, sessions: input.sessions }),
    checkGathererJudgeSession(input.run),
    checkGathererSkippedWhenContext(input.run),
  ];
  if (input.run.gatherer !== undefined) {
    const gathererEvidence = input.sessions.get(input.run.gatherer.sessionID);
    checks.push(
      ...evaluateRoleChecks({
        run: input.run,
        role: "gatherer",
        messageID: input.run.gatherer.messageID,
        model: input.run.gatherer.model,
        status: input.run.gatherer.status,
        ...(input.run.gatherer.startedAt === undefined
          ? {}
          : { startedAt: input.run.gatherer.startedAt }),
        ...(gathererEvidence === undefined
          ? {}
          : { evidence: gathererEvidence }),
      }),
    );
  }
  if (input.run.judge !== undefined) {
    const judgeEvidence = input.sessions.get(input.run.judge.sessionID);
    checks.push(
      ...evaluateRoleChecks({
        run: input.run,
        role: "judge",
        messageID: input.run.judge.messageID,
        model: input.run.judge.model,
        status: input.run.judge.status,
        ...(input.run.judge.startedAt === undefined
          ? {}
          : { startedAt: input.run.judge.startedAt }),
        ...(judgeEvidence === undefined ? {} : { evidence: judgeEvidence }),
      }),
    );
  }
  for (const reviewer of input.run.reviewers) {
    const reviewerEvidence = input.sessions.get(reviewer.sessionID);
    checks.push(
      ...evaluateRoleChecks({
        run: input.run,
        role: `reviewer:${reviewer.reviewer}`,
        messageID: reviewer.messageID,
        model: reviewer.model,
        status: reviewer.status,
        ...(reviewer.startedAt === undefined
          ? {}
          : { startedAt: reviewer.startedAt }),
        ...(reviewerEvidence === undefined
          ? {}
          : { evidence: reviewerEvidence }),
      }),
    );
  }
  return checks;
}
