// Stand-in for the desktop app in MCP auto-launch tests: starts Lumina with the mock provider.
import { startLumina } from '../../src/app.js';

await startLumina({ dataRoot: process.env.LUMINA_DATA_DIR, enableMock: true, log: { info() {}, error() {} } });
