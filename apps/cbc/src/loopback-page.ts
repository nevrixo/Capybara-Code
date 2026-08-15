/** Self-contained, ultra-clean HTML page for the local OAuth callback. */

export interface LoopbackPageOptions {
  readonly language?: string;
  readonly brand?: string;
  readonly successTitle?: string;
  readonly successMessage?: string;
  readonly successLabel?: string;
  readonly errorTitle?: string;
  readonly errorMessage?: string;
  readonly errorLabel?: string;
  readonly closeHint?: string;
}

export interface RenderLoopbackPageOptions {
  readonly status: "success" | "error";
  /** Legacy message, retained as the default success message. */
  readonly message: string;
  readonly page?: LoopbackPageOptions;
}

/**
 * Render the local OAuth callback page.
 */
export function renderLoopbackPage(options: RenderLoopbackPageOptions): string {
  const copy = options.page ?? {};
  const success = options.status === "success";
  const language = escapeHtml(copy.language ?? "en");
  const brand = escapeHtml(copy.brand ?? "Capybara Code");
  const title = escapeHtml(
    success
      ? (copy.successTitle ?? "Login Success!")
       : (copy.errorTitle ?? "Callback needs attention"),
  );
  const message = escapeHtml(
    success
      ? (copy.successMessage ?? options.message)
      : (copy.errorMessage ??
        "The authorization response was declined or invalid. Return to Capybara Code and try again."),
  );
  const closeHint = escapeHtml(copy.closeHint ?? "You can close this tab now.");
  const statusClass = success ? "success" : "error";

  const statusBadgeIcon = success
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
       </svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
       </svg>`;

  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${title} - ${brand}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg-gradient: linear-gradient(135deg, #f8f9fd 0%, #edf1f9 50%, #e2e7f6 100%);
        --ink: #111827;
        --muted: #4b5563;
        --ok-circle: #10b981;
        --error-circle: #ef4444;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg-gradient: linear-gradient(135deg, #0b0c10 0%, #12151e 50%, #171b26 100%);
          --ink: #f9fafb;
          --muted: #9ca3af;
          --ok-circle: #10b981;
          --error-circle: #f87171;
        }
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      html, body {
        height: 100%;
        width: 100%;
        margin: 0;
        padding: 0;
        overflow: hidden;
      }

      body {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        background: var(--bg-gradient);
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: var(--ink);
        -webkit-font-smoothing: antialiased;
      }

      main {
        width: 100%;
        max-width: 520px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 0 24px;
        animation: fadeIn 0.4s ease-out;
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      /* Clean Check Icon Circle */
      .icon-circle {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background-color: var(--ok-circle);
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 20px;
        box-shadow: 0 10px 24px rgba(16, 185, 129, 0.35);
      }
      .icon-circle.error {
        background-color: var(--error-circle);
        box-shadow: 0 10px 24px rgba(239, 68, 68, 0.35);
      }
      .icon-circle svg {
        width: 30px;
        height: 30px;
      }

      /* Title & Text Centering */
      h1 {
        font-size: 32px;
        font-weight: 800;
        line-height: 1.25;
        letter-spacing: -0.025em;
        color: var(--ink);
        text-align: center;
        margin-bottom: 12px;
        width: 100%;
      }
      .message {
        font-size: 15px;
        line-height: 1.6;
        color: var(--muted);
        max-width: 440px;
        text-align: center;
        margin-bottom: 12px;
        width: 100%;
      }

      .close-hint {
        font-size: 14px;
        font-weight: 500;
        color: var(--muted);
        text-align: center;
        margin: 0;
        width: 100%;
      }
    </style>
  </head>
  <body>
    <main aria-labelledby="page-title">
      <div class="icon-circle ${statusClass}" role="status" aria-live="polite">
        ${statusBadgeIcon}
      </div>
      <h1 id="page-title">${title}</h1>
      <p class="message">${message}</p>
      <p class="close-hint">${closeHint}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}
