import fs from 'node:fs';

// Simple logger with console output + append to a sink file.
// Not async (fs.appendFileSync) to guarantee ordering and no lost output
// if the process exits abruptly (launchd).
export function createLogger(sinkPath) {
  try { fs.writeFileSync(sinkPath, ''); } catch {}
  let successes = 0;
  let errors = 0;
  const startedAt = Date.now();

  function write(level, msg) {
    const line = `[${new Date().toISOString()}] ${level.padEnd(7)} ${msg}`;
    console.log(line);
    try { fs.appendFileSync(sinkPath, line + '\n'); } catch {}
  }

  return {
    info:    (m) => write('info', m),
    warn:    (m) => write('warn', m),
    error:   (m) => { write('error', m); errors++; },
    success: (m) => { write('success', m); successes++; },
    summary: () => ({ successes, errors, durationMs: Date.now() - startedAt }),
    sinkPath
  };
}
