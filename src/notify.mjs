import { spawn } from 'node:child_process';

/**
 * Default severity-based routing matrix.
 * Destinations: log, terminal, toast, queue.
 * @type {Object<string, string[]>}
 */
export const DEFAULT_ROUTES = {
  info: ['log'],
  warn: ['terminal', 'bridge'],
  block: ['terminal', 'toast', 'queue'],
  health: ['terminal', 'toast', 'queue'],
};

function normalize(text) {
  return String(text).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Build a platform-specific toast command.
 * @param {string} title
 * @param {string} message
 * @returns {[string, string[]]|null}
 */
function toastCommand(title, message) {
  const os = process.platform;
  const t = normalize(title);
  const m = normalize(message);

  if (os === 'win32') {
    const safeTitle = t.replace(/'/g, "''");
    const safeMessage = m.replace(/'/g, "''");
    const command = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$notify = New-Object System.Windows.Forms.NotifyIcon;",
      "$notify.Icon = [System.Drawing.SystemIcons]::Information;",
      `$notify.BalloonTipTitle = '${safeTitle}';`,
      `$notify.BalloonTipText = '${safeMessage}';`,
      "$notify.Visible = $true;",
      "$notify.ShowBalloonTip(5000)",
    ].join(' ');
    return ['powershell.exe', ['-NoProfile', '-Command', command]];
  }

  if (os === 'darwin') {
    const quotedTitle = JSON.stringify(t);
    const quotedMessage = JSON.stringify(m);
    return ['osascript', ['-e', `display notification ${quotedMessage} with title ${quotedTitle}`]];
  }

  if (os === 'linux') {
    return ['notify-send', [t, m]];
  }

  return null;
}

/**
 * Send a native OS toast notification, fire-and-forget.
 * @param {string} title
 * @param {string} message
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function sendToast(title, message) {
  const cmd = toastCommand(title, message);
  if (!cmd) return Promise.resolve({ ok: false, error: `unsupported platform: ${process.platform}` });

  const [program, args] = cmd;
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    let failed = false;
    child.on('error', (err) => {
      failed = true;
      resolve({ ok: false, error: err.message });
    });
    child.on('exit', (code) => {
      if (!failed) {
        resolve(code === 0 ? { ok: true } : { ok: false, error: `exit code ${code}` });
      }
    });
    // Give up after 10s so a hung notifier never blocks enforcement.
    setTimeout(() => {
      if (!failed) {
        failed = true;
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, error: 'timeout' });
      }
    }, 10000);
  });
}

/**
 * Notifier — routes gateinitiative events to terminal, bridge, queue, and OS toast.
 *
 * @typedef {Object} NotifyEvent
 * @property {string} severity - 'info' | 'warn' | 'block' | 'health'
 * @property {string} title
 * @property {string} message
 * @property {string} [category] - health category (e.g. 'revert_failed')
 * @property {boolean} [toast] - force toast on/off for this event
 */
export class Notifier {
  /**
   * @param {Object} options
   * @param {boolean} [options.toastEnabled=true]
   * @param {Object<string,string[]>} [options.routes=DEFAULT_ROUTES]
   * @param {function} [options.terminal] - function to call for terminal output
   * @param {function} [options.onToastFailure] - callback when toast fails (e.g. health.report)
   */
  constructor(options = {}) {
    this.toastEnabled = options.toastEnabled ?? true;
    this.routes = { ...DEFAULT_ROUTES, ...(options.routes || {}) };
    this.terminal = options.terminal || (() => {});
    this.onToastFailure = options.onToastFailure || (() => {});
  }

  /**
   * Route an event to configured destinations.
   * @param {NotifyEvent} event
   * @returns {Promise<string[]>} list of destinations notified
   */
  async notify(event) {
    const severity = event.severity || 'info';
    const destinations = new Set(this.routes[severity] || ['log']);
    if (event.toast === true) destinations.add('toast');
    if (event.toast === false) destinations.delete('toast');

    const sent = [];

    if (destinations.has('terminal')) {
      this.terminal(event);
      sent.push('terminal');
    }

    if (destinations.has('toast') && this.toastEnabled) {
      const result = await sendToast(event.title, event.message);
      if (!result.ok) {
        this.onToastFailure({
          severity: 'warn',
          category: 'notify_failed',
          message: `Toast failed: ${result.error}`,
          detail: event,
        });
      } else {
        sent.push('toast');
      }
    }

    if (destinations.has('queue')) {
      // Queue destination is handled by the caller (e.g. recordPendingDecision).
      sent.push('queue');
    }

    if (destinations.has('log') || sent.length === 0) {
      sent.push('log');
    }

    return sent;
  }
}
