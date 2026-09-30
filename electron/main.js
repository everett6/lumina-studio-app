import { app, BrowserWindow, dialog, safeStorage, session, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startLumina } from '../src/app.js';

let lumina = null;
let win = null;

// A second launch only focuses the running window; it must not start another backend (which would
// overwrite endpoint.json while the first instance is still serving).
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);

// Encrypt keys with the OS keyring (libsecret/kwallet). Electron's 'basic_text' fallback is not real
// encryption, so treat it as unavailable and let the UI say keys are stored unencrypted.
function keyCipher() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null;
  return {
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
  };
}

function lockDown(contents, origin) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 960, minHeight: 640, backgroundColor: '#11110f', title: 'Lumina Studio', show: false,
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true },
  });
  win.setMenuBarVisibility(false);
  lockDown(win.webContents, lumina.origin);
  win.once('ready-to-show', () => win.show());
  await win.loadURL(lumina.launchUrl);

  // Packaging smoke test: capture the rendered window and exit.
  if (process.env.LUMINA_SMOKE_SCREENSHOT) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    writeFileSync(process.env.LUMINA_SMOKE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    app.quit();
  }
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  if (!primary) return;
  try {
    lumina = await startLumina({
      dataRoot: process.env.LUMINA_DATA_DIR || app.getPath('userData'),
      port: Number(process.env.LUMINA_PORT || 0),
      cipher: keyCipher(),
      mode: 'desktop',
    });
  } catch (error) {
    dialog.showErrorBox('Lumina Studio could not start', String(error?.stack || error));
    app.exit(1);
    return;
  }

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  session.defaultSession.on('will-download', (event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', (event) => {
  if (!lumina) return;
  event.preventDefault();
  const closing = lumina;
  lumina = null;
  closing.close().finally(() => app.exit(0));
});
