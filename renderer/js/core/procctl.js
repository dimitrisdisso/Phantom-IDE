// Ending processes from the System Monitor and the Process manager (confirm → signal → feedback).
import { call, platform } from './api.js';
import { confirm, toast, fail } from './ui.js';

const isWin = () => platform === 'win32';

/**
 * End a process. mode: 'end' (SIGTERM; on Windows this is End task), 'kill' (SIGKILL, cannot be
 * caught) or 'tree' (the process and every process it started). Resolves true when it was sent.
 */
export async function endProcess(p, mode = 'end') {
  if (!p) return false;
  const what = `${p.name} (pid ${p.pid}${p.user ? ', user ' + p.user : ''})`;
  const titles = { end: 'End process', kill: 'Force kill process', tree: 'End process tree' };
  const body = {
    end: `End ${what}?${isWin() ? '\n\nWindows ends it immediately — unsaved work in that program will be lost.' : '\n\nIt receives SIGTERM and can shut down cleanly.'}`,
    kill: `Force kill ${what}?\n\nSIGKILL cannot be caught — unsaved work in that process will be lost.`,
    tree: `End ${what} and every process it started?\n\nUnsaved work in those programs will be lost.`
  }[mode];
  const cmd = (p.command || '').slice(0, 200);
  if (!(await confirm(titles[mode], body + (cmd ? `\n\n${cmd}` : ''), { danger: true, ok: mode === 'tree' ? 'END TREE' : mode === 'kill' ? 'KILL' : 'END PROCESS' }))) return false;
  try {
    if (mode === 'tree') { const n = await call('proc:killTree', p.pid); toast(`ended ${p.name} and ${n - 1} child process${n === 2 ? '' : 'es'}`, 'info', 'PROCESS'); }
    else { await call('proc:kill', p.pid, mode === 'kill' ? 'SIGKILL' : 'SIGTERM'); toast(`ended ${p.name} (${p.pid})`, 'info', 'PROCESS'); }
    return true;
  } catch (e) { fail(e, 'PROCESS'); return false; }
}
