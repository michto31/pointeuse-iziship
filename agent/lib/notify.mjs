import { spawn } from 'node:child_process';

// Envoie une notification macOS via osascript. Utilise spawn (pas exec) pour éviter
// les problèmes d'échappement shell — JSON.stringify donne des strings AppleScript
// correctement quotées avec double quotes.
export function notifyMacOS(title, message, subtitle = '') {
  const script = subtitle
    ? `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} subtitle ${JSON.stringify(subtitle)}`
    : `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
  child.on('error', () => { /* osascript indisponible : silencieux, l'agent ne doit pas crasher pour ça */ });
}
