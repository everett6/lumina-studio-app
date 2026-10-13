import { app } from 'electron';

// The packaged binary doubles as a stdio MCP helper. Helpers do not take the desktop single-instance lock,
// open a renderer, or start another backend. Each client uses the same authenticated desktop API.
if (process.argv.includes('--mcp')) {
  app.disableHardwareAcceleration();
  process.env.LUMINA_DATA_DIR ||= app.getPath('userData');
  if (app.isPackaged) process.env.LUMINA_APP_COMMAND ||= process.env.APPIMAGE || process.execPath;
  process.stdin.once('end', () => app.quit());
  process.once('SIGTERM', () => app.exit(0));
  process.once('SIGINT', () => app.exit(0));
  try {
    await import('../mcp/server.js');
  } catch (error) {
    console.error('Lumina MCP could not start:', error.message);
    app.exit(1);
  }
} else {
  await import('./main.js');
}
