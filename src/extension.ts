import * as vscode from 'vscode';
import * as path from 'path';
import * as bolt from './boltClient';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'boltdbViewer.editor',
      new BoltDBEditorProvider(context),
      { 
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boltdbViewer.open', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'BoltDB Files': ['db', 'bolt', 'boltdb', 'bbolt'],
          'All Files': ['*']
        },
        title: 'Open BoltDB File'
      });
      
      if (uris && uris.length > 0) {
        const uri = uris[0];
        try {
          await vscode.commands.executeCommand('vscode.openWith', uri, 'boltdbViewer.editor');
        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to open BoltDB file: ${error.message}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boltdbViewer.exportBucket', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      const dbPath = editor.document.uri.fsPath;
      const bucketPath = await vscode.window.showInputBox({ prompt: 'Bucket path (slash-separated, blank for root)' });
      const outUri = await vscode.window.showSaveDialog({ filters: { 'JSONL': ['jsonl'] } });
      if (!outUri) { return; }
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting bucket...' }, async () => {
        try {
          await bolt.exportBucket(dbPath, bucketPath || '', outUri.fsPath);
          vscode.window.showInformationMessage('Export complete: ' + outUri.fsPath);
        } catch (e: any) {
          vscode.window.showErrorMessage('Export failed: ' + e.message);
        }
      });
    })
  );
}

class BoltDBEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
  constructor(private context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
    // Check if this is actually a BoltDB file
    const isBolt = await bolt.isBoltDB(uri.fsPath);
    if (!isBolt) {
      throw new Error('This file does not appear to be a valid BoltDB database. The BoltDB Viewer can only open BoltDB/bbolt format files.');
    }
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
    const dbPath = document.uri.fsPath;

    const post = (msg: any) => webviewPanel.webview.postMessage(msg);

    webviewPanel.webview.onDidReceiveMessage(async msg => {
      try {
        if (msg.type === 'listKeys') {
          const res = await bolt.listKeys(dbPath, msg.bucketPath, { limit: 1000, afterKey: msg.afterKey });
          post({ type: 'keys', ...res });
        } else if (msg.type === 'readHead') {
          const res = await bolt.readHead(dbPath, msg.bucketPath, msg.keyBase64);
          post({ type: 'head', ...res });
        } else if (msg.type === 'saveValue') {
          const outUri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(msg.keyBase64 + '.bin') });
          if (!outUri) { return; }
          await bolt.saveToFile(dbPath, msg.bucketPath, msg.keyBase64, outUri.fsPath);
          vscode.window.showInformationMessage('Value saved: ' + outUri.fsPath);
        } else if (msg.type === 'listBuckets') {
          const res = await bolt.listBuckets(dbPath, msg.bucketPath);
          post({ type: 'buckets', ...res });
        } else if (msg.type === 'search') {
          const res = await bolt.search(dbPath, msg.query, msg.limit, msg.caseSensitive);
          post({ type: 'searchResults', ...res });
        }
      } catch (e: any) {
        post({ type: 'error', message: e.message });
      }
    });
  }

  getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'webview.js')));
    const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'styles.css')));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-eval' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>BoltDB Viewer</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function deactivate() {}
