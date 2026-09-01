/**
 * Canonical global configuration templates.
 *
 * Capybara Code has one configuration file. The short template is created on
 * first use and `/setting` persists supported interactive choices here.
 * Keep executable integrations visible here instead of hiding them in runtime
 * defaults so users can disable, replace, or remove them.
 */

export const GLOBAL_CONFIG_TEMPLATE = `# Capybara Code global config
# Keys are snake_case on disk and camelCase in code.

[model]
default = "gpt-5.6-sol"
reasoning_effort = "medium"

[model.reasoning]
provider_summary = "auto"

# Recommended profiles (§6 P1-03). A profile bundles three strategies — which
# model answers, how the turn executes, and how wide its verification has to be —
# so selecting one changes more than the model. Pick one with
# \`capy model use profile:<name>\` or \`/model profile:<name>\`.
#
#   fast      terra/low   · direct first, small program budget · focused
#   balanced  sol/medium  · program lane when eligible         · package
#   deep      sol/high    · hosted read-only scout + local writer · independent review
#   quality   sol/pro     · multi-agent only on a clean split  · independent review
#
# \`auto\` is the shipped default and stays there: the highest tier is promoted
# only once a bench run shows it earns the cost, so no profile ships max effort.
# A profile narrows what you set below; it never widens it.
# [model]
# profile = "auto"

# Context compaction v2. Safety ratios use the model's input capacity after the
# output reserve; the soft target is optimization-only and never an overflow cap.
# [model.context]
# compaction_strategy = "model-summary"
# compaction_prepare_ratio = 0.80
# compaction_trigger_ratio = 0.90
# compaction_emergency_ratio = 0.97
# compaction_target_ratio = 0.60
# compaction_model = "same"
# compaction_reasoning_effort = "low"
# compaction_recent_turns = 2
# compaction_max_attempts_per_generation = 1
# compaction_min_new_tokens = 4096
# compaction_fallback = "evidence-ledger"
# context_gauge_basis = "model-input-capacity"
# optimization_target_tokens = 192000
# max_input_tokens = 900000 # optional explicit hard cap; omit for model capacity

# Provider backend and transport (§8.4). \`transport\` and \`service_tier\` are wired.
# \`profile\` is experimental: the backend is derived from the credential type, and
# this key states an expectation rather than overriding it.
# [provider.openai]
# profile = "auto"
# transport = "websocket"
# service_tier = "standard"

# Native lane budgets (§5.4, §8.4). The program lane is read-only; these are the
# ceilings a single program call runs under. A selected profile can lower them.
# [provider.openai.native]
# programmatic_tool_calling = "read-only"
# hosted_multi_agent = "read-only"
# max_program_tool_calls = 24
# max_program_parallel_calls = 6

# Prompt caching (§8.4). \`mode\` is wired. \`breakpoint\` and \`ttl\` are experimental:
# the planner always breaks at the stable prefix, and the provider pins the TTL to
# 30m, so neither value is sent. \`capy config validate --explain\` lists every key
# with its status rather than letting a no-op look wired.
# [model.cache]
# mode = "roi"
# breakpoint = "stable-prefix"
# ttl = "30m"

[agent]
permission_mode = "ask"
interaction_mode = "build"
review_mode = "auto"
deep_plan = "off"

[permissions]
project_write = "auto"
shell = "safe-auto"
network = "ask"
destructive = "ask"
credentials = "deny"
external_side_effect = "ask"

# Skills are discovered from the native Capybara root plus compatible
# .opencode, .agents, and .claude roots. Add shared roots here when needed.
[skills]
enabled = true
paths = []
compat_opencode = true
compat_agents = true
compat_claude = true
legacy_paths = true
max_roots = 64
max_candidates = 512
max_depth = 8
scan_timeout_ms = 1500

[skills.builtin]
enabled = true
disabled = []

[mcp.servers.context7]
transport = "streamable_http"
url = "https://mcp.context7.com/mcp"
auth = "none"
enabled = true
connect_on_startup = false
timeout_ms = 10000

# Language servers are started only for trusted Build workspaces.
# Capybara never downloads these commands automatically.
[lsp.servers.typescript]
command = "typescript-language-server"
args = ["--stdio"]
extensions = [".ts", ".tsx", ".mts", ".cts"]
language_id = "typescript"
enabled = true
install_hint = "npm install -g typescript-language-server typescript"
timeout_ms = 15000

[lsp.servers.python]
command = "pyright-langserver"
args = ["--stdio"]
extensions = [".py", ".pyi"]
language_id = "python"
enabled = true
install_hint = "npm install -g pyright"
timeout_ms = 15000

# Wired runtime surfaces are on by default. Set a gate to false to disable it.
# A project config cannot re-enable a gate the user turned off.
# [experimental]
# edit_engine_v2 = true
# full_lsp = true
# session_daemon = true
# durable_memory = true
# persistent_agent_graph = true
# worktree_multi_agent = true
# plugin_runtime = true
# app_server = true
# context_compaction_v2 = true
`;
