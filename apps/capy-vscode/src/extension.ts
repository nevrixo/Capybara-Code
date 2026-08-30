import * as vscode from "vscode";

import { digestText } from "@cbc/integration-core";
import { CapybaraClient } from "@cbc/sdk";

import {
  VscodeIntegrationController,
  type VscodeIntegrationStateStore,
} from "./controller.ts";

let activeController: VscodeIntegrationController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Capybara Code");
  const status = vscode.window.createStatusBarItem();
  status.name = "Capybara Code";
  status.text = "$(circle-outline) Capybara";
  status.command = "capybara.connect";
  status.show();

  const stateStore: VscodeIntegrationStateStore = {
    async loadCursor(sessionId) {
      return context.workspaceState.get("capybara.cursor." + sessionId);
    },
    async saveCursor(sessionId, cursor) {
      await context.workspaceState.update("capybara.cursor." + sessionId, cursor);
    },
  };

  const ensureController = async (): Promise<VscodeIntegrationController> => {
    if (activeController !== undefined && activeController.connection.phase !== "closed") {
      return activeController;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder === undefined) throw new Error("Open a workspace before connecting Capybara.");
    const daemonPath = vscode.workspace.getConfiguration("capybara").get("daemonPath", "");
    if (typeof daemonPath !== "string" || daemonPath.trim().length === 0) {
      throw new Error("Set capybara.daemonPath to the current-user daemon socket or named pipe.");
    }
    const workspaceIdentityDigest = digestText(
      String(workspaceFolder.uri.fsPath).replaceAll("\\", "/").toLowerCase(),
    );
    const controller = new VscodeIntegrationController({
      workspaceIdentityDigest,
      state: stateStore,
      connect: async () => CapybaraClient.connect({
        transport: process.platform === "win32" ? "pipe" : "unix",
        path: daemonPath,
        client: {
          name: "Capybara VS Code",
          version: String(context.extension?.packageJSON?.version ?? "0.1.0"),
          kind: "ide",
        },
      }),
    });
    controller.onEvent((event) => {
      if (event.kind === "state") {
        const phase = controller.connection.phase;
        status.text = phase === "ready" ? "$(circle-filled) Capybara" : "$(sync~spin) Capybara";
        status.tooltip = "Capybara runtime: " + phase;
      }
      void chatProvider.post({ type: "controller-event", event });
    });
    await controller.connect();
    activeController = controller;
    output.appendLine("Connected to Capybara daemon.");
    return controller;
  };

  const diffProvider = new MemoryContentProvider();
  const chatProvider = new CapybaraChatViewProvider(ensureController, output);
  context.subscriptions.push(
    output,
    status,
    vscode.workspace.registerTextDocumentContentProvider("capybara-diff", diffProvider),
    vscode.window.registerWebviewViewProvider("capybara.chat", chatProvider),
    vscode.commands.registerCommand("capybara.connect", async () => {
      try {
        await ensureController();
        void vscode.window.showInformationMessage("Capybara connected.");
      } catch (error) {
        void vscode.window.showErrorMessage(message(error));
      }
    }),
    vscode.commands.registerCommand("capybara.newSession", async () => {
      try {
        const controller = await ensureController();
        const cwd = String(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");
        const sessionId = await controller.createSession(cwd);
        void vscode.window.showInformationMessage("Capybara session " + sessionId + " attached.");
      } catch (error) {
        void vscode.window.showErrorMessage(message(error));
      }
    }),
    vscode.commands.registerCommand("capybara.attachSelection", async () => {
      try {
        const controller = await ensureController();
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) throw new Error("Open a text editor and select context first.");
        const selection = editor.selection;
        const text = editor.document.getText(selection);
        controller.attachEditorContext({
          uri: editor.document.uri.toString(),
          documentRevision: String(editor.document.version),
          languageId: editor.document.languageId,
          source: editor.document.isDirty ? "unsaved" : "disk",
          selection: {
            startLine: selection.start.line,
            startCharacter: selection.start.character,
            endLine: selection.end.line,
            endCharacter: selection.end.character,
          },
          ...(text.length === 0 ? { textDigest: digestText("") } : {
            selectedText: text,
            textDigest: digestText(text),
          }),
        });
        void vscode.window.showInformationMessage("Selection attached to the next Capybara turn.");
      } catch (error) {
        void vscode.window.showErrorMessage(message(error));
      }
    }),
    vscode.commands.registerCommand("capybara.cancelTurn", async () => {
      try {
        await (await ensureController()).cancel();
      } catch (error) {
        void vscode.window.showErrorMessage(message(error));
      }
    }),
    vscode.commands.registerCommand("capybara.reviewLatestDiff", async () => {
      try {
        const value = await (await ensureController()).latestDiff();
        await openFirstNativeDiff(value, diffProvider);
      } catch (error) {
        void vscode.window.showErrorMessage(message(error));
      }
    }),
  );

  if (vscode.workspace.getConfiguration("capybara").get("autoConnect", true) === true) {
    void ensureController().catch((error) => output.appendLine("Auto-connect: " + message(error)));
  }
}

export async function deactivate(): Promise<void> {
  await activeController?.dispose();
  activeController = undefined;
}

class CapybaraChatViewProvider implements vscode.WebviewViewProvider {
  #view: vscode.WebviewView | undefined;

  constructor(
    readonly ensureController: () => Promise<VscodeIntegrationController>,
    readonly output: { appendLine(text: string): void },
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = chatHtml(view.webview);
    view.webview.onDidReceiveMessage(async (incoming: unknown) => {
      const messageValue = asRecord(incoming);
      try {
        if (messageValue?.type === "submit" && typeof messageValue.text === "string") {
          const controller = await this.ensureController();
          if (controller.sessionId === undefined) {
            const cwd = String(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");
            await controller.createSession(cwd);
          }
          await controller.submit(messageValue.text);
        }
        if (messageValue?.type === "cancel") await (await this.ensureController()).cancel();
        if (messageValue?.type === "attach-selection") {
          await vscode.commands.executeCommand("capybara.attachSelection");
        }
      } catch (error) {
        this.output.appendLine(message(error));
        await view.webview.postMessage({ type: "error", message: message(error) });
      }
    });
  }

  async post(value: unknown): Promise<void> {
    await this.#view?.webview.postMessage(value);
  }
}

class MemoryContentProvider {
  readonly #content = new Map<string, string>();
  readonly #emitter = new vscode.EventEmitter();
  readonly onDidChange = this.#emitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.#content.set(uri.toString(), content);
    this.#emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#content.get(uri.toString()) ?? "";
  }
}

async function openFirstNativeDiff(value: unknown, provider: MemoryContentProvider): Promise<void> {
  const root = asRecord(value);
  const files = Array.isArray(root?.files) ? root.files : [];
  const file = asRecord(files[0]);
  if (
    typeof file?.path !== "string"
    || typeof file.beforeText !== "string"
    || typeof file.afterText !== "string"
  ) {
    throw new Error("The daemon did not return a rich diff with beforeText and afterText.");
  }
  const encoded = encodeURIComponent(file.path);
  const before = vscode.Uri.parse("capybara-diff:/before/" + encoded);
  const after = vscode.Uri.parse("capybara-diff:/after/" + encoded);
  provider.set(before, file.beforeText);
  provider.set(after, file.afterText);
  await vscode.commands.executeCommand("vscode.diff", before, after, "Capybara: " + file.path);
}

function chatHtml(webview: { readonly cspSource: string }): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "';\">",
    "<style nonce=\"" + nonce + "\">",
    "body{font:var(--vscode-font-size)/1.5 var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}",
    "label{display:block;margin-bottom:6px;font-weight:600}textarea{box-sizing:border-box;width:100%;min-height:110px;padding:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}",
    ".actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}button{padding:6px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}button:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}#status{margin-top:10px;white-space:pre-wrap}",
    "</style>",
    "</head>",
    "<body>",
    "<label for=\"prompt\">Message Capybara</label>",
    "<textarea id=\"prompt\" aria-describedby=\"status\"></textarea>",
    "<div class=\"actions\"><button id=\"send\" type=\"button\">Send</button><button id=\"attach\" type=\"button\">Attach selection</button><button id=\"cancel\" type=\"button\">Cancel turn</button></div>",
    "<div id=\"status\" role=\"status\" aria-live=\"polite\">Ready</div>",
    "<script nonce=\"" + nonce + "\">",
    "const vscode=acquireVsCodeApi();const prompt=document.getElementById('prompt');const status=document.getElementById('status');",
    "document.getElementById('send').addEventListener('click',()=>{const text=prompt.value.trim();if(text){status.textContent='Sending…';vscode.postMessage({type:'submit',text});prompt.value='';}});",
    "document.getElementById('attach').addEventListener('click',()=>vscode.postMessage({type:'attach-selection'}));document.getElementById('cancel').addEventListener('click',()=>vscode.postMessage({type:'cancel'}));",
    "window.addEventListener('message',(event)=>{const value=event.data;if(value.type==='error'){status.textContent=value.message;}else if(value.type==='controller-event'){status.textContent=JSON.stringify(value.event.value,null,2);}});",
    "</script>",
    "</body></html>",
  ].join("");
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
