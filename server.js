import { startLumina } from './src/app.js';

const app = await startLumina({ dataRoot: process.env.LUMINA_DATA_DIR, port: Number(process.env.PORT || 4173) });
console.log(`Lumina Studio is running. Open this link in your browser:\n  ${app.launchUrl}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
