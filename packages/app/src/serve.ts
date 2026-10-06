import { startServer } from '@salvia/server';
import { createSession, prewarm } from './index.ts';

// `npm run server`: the web UI alone (development).
if (process.argv.includes('--demo')) process.env.SALVIA_DEMO = '1';

const arg = process.argv.indexOf('--port');
const port = Number(arg > 0 ? process.argv[arg + 1] : (process.env.SALVIA_PORT ?? 8080));
prewarm();
const { address } = await startServer(createSession(), { port });
console.log(`Salvia server on ${address}`);
