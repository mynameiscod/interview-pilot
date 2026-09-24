// Runs the compiled API so that a CPU profile (node --cpu-prof) is written on
// exit even on Windows, where killing a child process skips exit handlers:
// the runner sends 'stop' over IPC and this wrapper exits normally.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

if (process.env.LOAD_ELD) {
  // Event-loop delay every 2 s (stderr), to tell CPU saturation from I/O waits.
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  setInterval(() => {
    process.stderr.write(
      `eld p50=${(h.percentile(50) / 1e6).toFixed(0)}ms p99=${(h.percentile(99) / 1e6).toFixed(0)}ms max=${(h.max / 1e6).toFixed(0)}ms
`,
    );
    h.reset();
  }, 2000).unref();
}

process.on('message', (msg) => {
  if (msg === 'stop') process.exit(0);
});
await import(pathToFileURL(join(process.cwd(), 'apps', 'api', 'dist', 'index.js')).href);
