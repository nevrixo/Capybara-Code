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

[agent]
permission_mode = "ask"
interaction_mode = "build"
review_mode = "auto"

[permissions]
project_write = "auto"
shell = "safe-auto"
network = "ask"
destructive = "ask"
credentials = "deny"
external_side_effect = "ask"

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

# Durable runtime surfaces are opt-in during the alpha rollout. Uncomment only
# after reviewing their security and recovery documentation.
# [experimental]
# edit_engine_v2 = false
# full_lsp = false
# session_daemon = false
# durable_memory = false
# persistent_agent_graph = false
# worktree_multi_agent = false
# plugin_runtime = false
# app_server = false
`;
