import { CROSS_REVIEW_START_PERMISSIONS } from "../cross-review/authorization.js";
import { READ_ONLY_TOOLS, REVIEWER_AGENT } from "../cross-review/tool.js";
import type { V2PermissionRule } from "./host.js";

// OpenCode 2.4.1 Agent.Info.default. Its leading built-in allow must not
// override a plugin default. User and per-agent rules are appended to this
// prefix; never move, deduplicate, or replace those rules (last match wins).
const NATIVE_DEFAULTS: readonly V2PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];

function sameRule(a: V2PermissionRule | undefined, b: V2PermissionRule) {
  return (
    a?.action === b.action && a.resource === b.resource && a.effect === b.effect
  );
}

export function withAskDefaults(
  rules: readonly V2PermissionRule[],
): V2PermissionRule[] {
  const offset = NATIVE_DEFAULTS.every((rule, i) => sameRule(rules[i], rule))
    ? NATIVE_DEFAULTS.length
    : 0;
  const missing = CROSS_REVIEW_START_PERMISSIONS.filter(
    (action) =>
      !rules.some((rule) => rule.action === action && rule.resource === "*"),
  ).map((action) => ({ action, resource: "*", effect: "ask" }) as const);
  return [...rules.slice(0, offset), ...missing, ...rules.slice(offset)];
}

// Disabling execute natively disables Code Mode's nested inventory and makes
// otherwise available tools direct. V2 shell and subagent replaced bash and
// task. File access outside the review location is not review evidence.
const CHILD_DENIES: readonly V2PermissionRule[] = [
  ...Object.keys(READ_ONLY_TOOLS),
  "shell",
  "subagent",
  "external_directory",
  "execute",
].map((action) => ({ action, resource: "*", effect: "deny" }));

export function childReviewPermissions(
  inherited: readonly V2PermissionRule[],
): V2PermissionRule[] {
  // Session.create's explicit permissions replace (rather than extend) the
  // parent's rules. Do not grant any read capability the host did not grant.
  return [...inherited, ...CHILD_DENIES.map((rule) => ({ ...rule }))];
}

export function hasChildReviewPermissions(
  rules: readonly V2PermissionRule[] | undefined,
): boolean {
  if (!rules || rules.length < CHILD_DENIES.length) return false;
  const offset = rules.length - CHILD_DENIES.length;
  return CHILD_DENIES.every((rule, i) => sameRule(rules[offset + i], rule));
}

// Only these native tools inspect review evidence. Drop names we do not know,
// including newly installed MCP tools: a previously unseen name is not evidence
// that a tool is read-only. This never adds tools missing from the host catalog.
const REVIEW_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "skill",
  "webfetch",
  "websearch",
]);

function isReviewToolAllowed(
  agent: string,
  disabled: ReadonlySet<string> | undefined,
  name: string,
): boolean {
  if (agent !== REVIEWER_AGENT && disabled === undefined) return true;
  return REVIEW_TOOLS.has(name) && !disabled?.has(name);
}

export function filterReviewTools(
  agent: string,
  disabled: ReadonlySet<string> | undefined,
  tools: Record<string, unknown>,
): void {
  for (const name of Object.keys(tools)) {
    if (!isReviewToolAllowed(agent, disabled, name))
      Reflect.deleteProperty(tools, name);
  }
}

export function assertReviewTool(
  agent: string,
  disabled: ReadonlySet<string> | undefined,
  name: string,
  registeredName?: string,
): void {
  if (
    !isReviewToolAllowed(agent, disabled, name) ||
    (registeredName !== undefined &&
      !isReviewToolAllowed(agent, disabled, registeredName))
  ) {
    throw new Error(`Tool is not available in a read-only review: ${name}`);
  }
}
