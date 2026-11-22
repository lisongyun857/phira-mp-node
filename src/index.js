import { createServer } from './server.js';
import { startConsole } from './console.js';
import { startQQBot } from './bot.js';
import { log } from './logger.js';

const DEFAULT_PORT = 12346;

function parsePort(argv) {
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let raw = null;
    if (arg === '-p' || arg === '--port') {
      raw = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--port=')) {
      raw = arg.slice('--port='.length);
    }
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0 && value < 65536) {
      port = value;
    }
  }
  return port;
}

const port = parsePort(process.argv.slice(2));
const { state, tcp } = createServer();

tcp.listen(port, () => {
  log.info(`Local Address: [::]:${port}`);
  startConsole(state, tcp);
  startQQBot(state);
});

process.on('uncaughtException', (e) => {
  log.error(`uncaught exception: ${e.stack || e}`);
});

process.on('unhandledRejection', (e) => {
  log.error(`unhandled rejection: ${e && e.stack ? e.stack : e}`);
});
