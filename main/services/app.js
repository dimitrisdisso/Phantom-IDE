'use strict';
const os = require('os');
const { which, run } = require('../util');

module.exports = (core) => {
  const w = () => core.hooks.window;
  return {
    'app:info': async () => {
      const git = which('git') ? (await run('git', ['--version'])).stdout.trim() : null;
      return {
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        user: os.userInfo().username,
        home: os.homedir(),
        dataDir: core.dataDir,
        versions: core.hooks.versions || { node: process.versions.node },
        shell: process.env.SHELL || process.env.COMSPEC || null,
        tools: {
          git, rg: !!which('rg'), ssh: !!which('ssh'), node: !!which('node'), python: !!(which('python3') || which('python')),
          docker: !!which('docker'), cargo: !!which('cargo'), go: !!which('go'),
          claude: !!which('claude'), copilot: !!which('copilot'), codex: !!which('codex')
        },
        electron: !!core.hooks.window
      };
    },
    'app:minimize': async () => w() && w().minimize(),
    'app:maximize': async () => w() && w().toggleMaximize(),
    'app:close': async () => w() && w().close(),
    'app:devtools': async () => w() && w().devtools(),
    'app:fullscreen': async () => w() && w().fullscreen(),
    'app:openExternal': async (url) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be opened');
      if (!core.hooks.openExternal) throw new Error('Not available in this runtime');
      await core.hooks.openExternal(url);
      return true;
    },
    'app:logs': async () => core.logs(),
    'app:log': async (level, message) => { core.log(['info', 'warn', 'error', 'debug'].includes(level) ? level : 'info', String(message).slice(0, 2000), 'UI'); return true; }
  };
};
