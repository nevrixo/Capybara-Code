# Capybara Code GitHub Action

The Action reduces GitHub payloads to a signed-shape trigger envelope before a
headless turn. It does not pass raw webhook JSON, repository secrets, or unknown
payload fields to the model. Delivery retries reuse the same idempotency digest.

The release bundle must place a verified capy executable beside dist/index.js.
For development only, capy-binary may point to an explicit absolute binary.

External comments, commits, pull requests, annotations, and artifacts must be
created through GitHubWriteCoordinator from a validated ActionResult. Agent prose
alone is never authority for an external side effect.
