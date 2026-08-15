/** Public hosted-agent lane entry point. Hosted agents are scouts/reviewers only. */

export {
  DEFAULT_HOSTED_SCOUT_POLICY,
  acceptHostedScoutReport,
  validateHostedScoutRequest,
  type HostedReportDecision,
  type HostedRole,
  type HostedScoutDecision,
  type HostedScoutPolicy,
  type HostedScoutReport,
  type HostedScoutRequest,
} from "./native-lanes.ts";
