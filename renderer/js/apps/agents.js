// Provider CLI launcher: agents run in ordinary project-scoped PTY terminals.
import { h, esc, icon } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { toast, fail } from '../core/ui.js';
import { wm } from '../core/wm.js';

const PROVIDERS = [
  {
    id: 'claude', name: 'Claude Code', executable: 'claude',
    args: ['--permission-mode', 'default'],
    description: 'Anthropic coding agent',
    install: 'npm install -g @anthropic-ai/claude-code',
    url: 'https://docs.anthropic.com/en/docs/claude-code/overview'
  },
  {
    id: 'copilot', name: 'GitHub Copilot', executable: 'copilot',
    args: [],
    description: 'GitHub Copilot CLI',
    install: 'npm install -g @github/copilot',
    url: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'
  },
  {
    id: 'codex', name: 'Codex', executable: 'codex',
    args: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'],
    description: 'OpenAI coding agent',
    install: 'npm install -g @openai/codex',
    url: 'https://developers.openai.com/codex/cli'
  }
];

export default {
  id: 'agents', title: 'Agents', icon: 'debug', desc: 'Launch coding agents in project terminals', size: [720, 500], min: [420, 300],
  async create(win) {
    const root = h('div.ag-root.fill.scroll');
    win.body.appendChild(root);
    let tools = {};
    let loading = true;

    async function launch(provider) {
      if (!project.root) {
        toast('Open a project before launching an agent.', 'warn');
        return;
      }
      if (!tools[provider.id]) {
        toast(`${provider.name} CLI was not found on PATH. Install it, then restart PHANTOM.`, 'warn');
        return;
      }
      try {
        const terminal = await wm.open('terminal', {
          state: { cwd: project.root, title: `${provider.name} · ${project.name}` }
        });
        if (!terminal || !terminal.instance || !terminal.instance.exec) throw new Error('Could not open a terminal');
        await terminal.instance.exec([provider.executable, ...provider.args].join(' '));
      } catch (e) {
        fail(e, `LAUNCH ${provider.name.toUpperCase()}`);
      }
    }

    function render() {
      root.replaceChildren();
      root.append(
        h('div.ag-head',
          h('div', h('div.ag-eyebrow', 'PROVIDER CLI'), h('h2', 'Coding agents')),
          h('div.ag-project', { html: project.root ? `${icon('folder')}<span>${esc(project.name)} · ${esc(project.root)}</span>` : 'No project open' })
        ),
        h('p.ag-note', 'Launches each CLI in a terminal rooted at the active project. Claude uses manual permission mode; Codex starts read-only and asks before approval escalations; Copilot uses its interactive CLI defaults. No auto-approve or bypass flags are used.')
      );

      const cards = h('div.ag-cards');
      for (const provider of PROVIDERS) {
        const installed = !!tools[provider.id];
        const button = h('button.btn' + (installed ? '' : '.ghost'), {
          disabled: loading || !installed || !project.root,
          on: { click: () => launch(provider) }
        }, installed ? 'OPEN IN TERMINAL' : loading ? 'CHECKING…' : 'NOT INSTALLED');
        const card = h('section.ag-card',
          h('div.ag-card-head',
            h('div.ag-mark', { html: icon('debug') }),
            h('div.ag-title', h('h3', provider.name), h('span', provider.description)),
            h('span.ag-state' + (installed ? '.ready' : ''), loading ? 'CHECKING' : installed ? 'AVAILABLE' : 'MISSING')
          ),
          h('div.ag-command', h('span', 'LAUNCH COMMAND'), h('code', [provider.executable, ...provider.args].join(' '))),
          !installed && !loading ? h('div.ag-install', h('span', 'INSTALL'), h('code', provider.install)) : null,
          h('div.ag-card-foot', button, h('a.ag-docs', { href: provider.url, target: '_blank', rel: 'noreferrer' }, 'Setup docs ↗'))
        );
        cards.appendChild(card);
      }
      root.append(cards,
        h('div.ag-security',
          h('b', 'Review actions before approving'),
          h('span', 'Each provider owns its sign-in and approval prompts. Check its displayed permission mode before approving; terminal commands can have effects beyond the project folder.')
        )
      );
    }

    async function refresh() {
      loading = true;
      render();
      try {
        const info = await call('app:info');
        tools = info.tools || {};
      } catch (e) {
        fail(e, 'AGENT AVAILABILITY');
      } finally {
        loading = false;
        render();
      }
    }

    const off = bus.on('project:changed', render);
    await refresh();
    return { destroy: off };
  }
};
