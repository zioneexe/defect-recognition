/* `npm start`: the dataset folder server plus `ng serve`, which proxies /api to it. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { start } from './dataset.mjs';

await start();
const ng = createRequire(import.meta.url).resolve('@angular/cli/bin/ng.js');
const child = spawn(process.execPath, [ng, 'serve', '--proxy-config', 'proxy.conf.json', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
