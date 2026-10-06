import { resolve } from 'node:path';
import { browserLogin, loginName, loginSites } from './browser.ts';
import { proxySites } from './http.ts';
import { loadConfig, saveConfig } from './config.ts';
import { allSettings, getSetting, setSetting, settingDef, settingLabel, type SettingDef } from './settings.ts';
import type { SalviaModule } from './registry.ts';
import type { Command, Context, Session } from './session.ts';

/** Commands that replace a settings page. Modules add their own (`@spotify`, `@source` ...). */
/** The sites for @login / @cookie, marked when already logged in. */
function siteOptions() {
  const cookies = loadConfig().cookies;
  return [...loginSites()].map(([id, s]) => ({ value: id, meta: `${s.name}${cookies[s.cookie] ? ' · 已登录' : ''}` }));
}

/** @dir, @cookie, @login, @proxy, @setting, @clear. */
export const coreModule: SalviaModule = {
  id: 'core',
  setup(api) {
    for (const c of coreCommands()) api.command(c);
  },
};

/** The same commands on one session (tests, sessions without the module registry). */
export function registerCoreCommands(session: Session): void {
  for (const c of coreCommands()) session.registerCommand(c);
}

function coreCommands(): Command[] {
  const list: Command[] = [];
  const session = { registerCommand: (c: Command) => list.push(c) };
  session.registerCommand({
    name: 'dir',
    usage: '@dir <下载目录>',
    complete: (args) => (args.length === 1 ? [{ value: '', meta: `输入新的下载目录；当前：${loadConfig().downloadDir}` }] : []),
    run([path], ctx) {
      if (!path) return ctx.status(`下载目录：${loadConfig().downloadDir}`, 'idle');
      const dir = resolve(path);
      saveConfig({ downloadDir: dir });
      ctx.status(`下载目录已设为 ${dir}`, 'ok');
    },
  });

  session.registerCommand({
    name: 'cookie',
    usage: '@cookie <网站> <cookie>（手动粘贴；推荐用 @login 浏览器登录）',
    complete: (args) =>
      args.length === 1
        ? siteOptions()
        : args.length === 2
          ? [{ value: '', meta: `粘贴从浏览器复制的 Cookie；更省事：@login ${loginName(args[0]) ?? args[0]}` }]
          : [],
    run([site, ...rest], ctx) {
      const cookies = { ...loadConfig().cookies };
      if (!site) {
        const names = [...loginSites()]
          .filter(([, s]) => cookies[s.cookie])
          .map(([id]) => id);
        return ctx.status(`${names.length ? `已登录：${names.join('、')}。` : ''}推荐用 @login <网站> 在浏览器里登录，自动保存；也可以 @cookie <网站> <cookie> 手动粘贴。`, 'idle');
      }
      const name = loginName(site);
      const key = name ? loginSites().get(name)!.cookie : site;
      const value = rest.join(' ').trim();
      if (value) cookies[key] = value;
      else delete cookies[key];
      saveConfig({ cookies });
      ctx.status(value ? `已保存 ${name ?? site} 的 cookie。下次可以直接用 @login ${name ?? site}，不用手动复制。` : `已清除 ${name ?? site} 的登录。`, 'ok');
    },
  });

  session.registerCommand({
    name: 'login',
    usage: '@login <网站>（浏览器登录自己的账号，自动保存）',
    complete: (args) => (args.length === 1 ? siteOptions() : []),
    async run([site], ctx) {
      const name = loginName(site);
      const target = name ? loginSites().get(name) : undefined;
      if (!target) {
        const list = [...loginSites()].map(([id, s]) => `${id}（${s.name}）`).join('、');
        return ctx.status(`${site ? `没有网站"${site}"。` : ''}登录哪个网站？@login ${[...loginSites().keys()].join(' / ')}。可用：${list}`, site ? 'error' : 'idle');
      }
      ctx.status(`正在打开浏览器登录${target.name}`);
      const cookie = await browserLogin(target, { signal: ctx.signal, onStatus: (text) => ctx.status(text) });
      saveConfig({ cookies: { ...loadConfig().cookies, [target.cookie]: cookie } });
      ctx.status(`已登录${target.name}，已保存${target.done ? `：${target.done}` : ''}。`, 'ok');
    },
  });

  session.registerCommand({
    name: 'proxy',
    usage: '@proxy <网站|*> [http://代理地址]（用 Tab 查看可选的网站）',
    complete(args) {
      const proxies = (loadConfig().extra.proxy as Record<string, string> | undefined) ?? {};
      if (args.length === 1) return [...proxySites(), '*'].map((id) => ({ value: id, meta: proxies[id] ? `当前 ${proxies[id]}` : id === '*' ? '所有网站' : undefined }));
      if (args.length === 2) {
        const now = proxies[args[0]!];
        return [...(now ? [{ value: now, meta: '当前' }] : []), { value: '', meta: '输入代理地址，例如 http://127.0.0.1:7890；留空则取消' }];
      }
      return [];
    },
    run([site, url], ctx) {
      const extra = { ...loadConfig().extra };
      const proxies = { ...((extra.proxy as Record<string, string> | undefined) ?? {}) };
      if (!site) {
        const list = Object.entries(proxies).map(([k, v]) => `${k} → ${v}`);
        return ctx.status(list.length ? list.join('；') : '没有设置代理。', 'idle');
      }
      if (url && !/^https?:\/\//.test(url)) return ctx.status('代理地址需要以 http:// 或 https:// 开头。', 'error');
      if (url) proxies[site] = url;
      else delete proxies[site];
      extra.proxy = proxies;
      saveConfig({ extra });
      ctx.status(url ? `${site} 走代理 ${url}` : `已取消 ${site} 的代理`, 'ok');
    },
  });

  session.registerCommand({
    name: 'setting',
    usage: '@setting [设置项] [值]（主题、样式、偏好、多线程下载）',
    bare: true,
    complete(args) {
      if (args.length === 1) return allSettings().map((s) => ({ value: s.key, meta: `${s.group} · ${s.label}：${settingLabel(s)}` }));
      const def = settingDef(args[0]!);
      if (args.length === 2 && def) {
        return def.options
          ? def.options.map((o) => ({ value: o.value, meta: `${o.label}${o.value === getSetting(def.key) ? ' · 当前' : ''}` }))
          : [{ value: '', meta: `输入${def.label}；当前：${settingLabel(def)}` }];
      }
      return [];
    },
    run([key, ...rest], ctx) {
      if (!key) return showSettings(ctx);
      const def = settingDef(key);
      if (!def) return ctx.status(`没有设置项"${key}"。输入 @setting 查看全部。`, 'error');
      const value = rest.join(' ');
      if (!value) return showOptions(ctx, def);
      const err = setSetting(def.key, value);
      if (err) return ctx.status(err, 'error');
      ctx.status(`${def.label}：${settingLabel(def)}`, 'ok');
    },
  });

  session.registerCommand({
    name: 'clear',
    usage: '@clear（清除已结束的任务）',
    run(_, ctx) {
      ctx.clearFinished();
      ctx.status('', 'idle');
    },
  });
  return list;
}

/** The settings as a table; picking one lists its values. */
function showSettings(ctx: Context): void {
  ctx.status('设置 · 选择一项修改（也可以直接输入 @setting <设置项> <值>）', 'idle');
  ctx.items(
    allSettings().map((def) => ({
      id: `set:${def.key}`,
      title: `${def.label}：${settingLabel(def)}`,
      meta: def.group,
      cells: [def.group, def.label, settingLabel(def)],
      pick: () => showOptions(ctx, def),
    })),
    {
      columns: [
        { title: '分组', width: 6 },
        { title: '设置', flex: 2 },
        { title: '当前', flex: 2 },
      ],
    },
  );
}

function showOptions(ctx: Context, def: SettingDef): void {
  if (!def.options) return ctx.status(`修改${def.label}：输入 @setting ${def.key} <值>。当前：${settingLabel(def)}`, 'idle');
  const now = getSetting(def.key);
  ctx.status(`${def.group} · ${def.label}${def.hint ? `（${def.hint}）` : ''}`, 'idle');
  ctx.items(
    def.options.map((o) => ({
      id: `opt:${o.value}`,
      title: `${o.value === now ? '● ' : '  '}${o.label}`,
      meta: o.value === now ? '当前' : undefined,
      pick: () => {
        const err = setSetting(def.key, o.value);
        if (err) return ctx.status(err, 'error');
        showSettings(ctx);
        ctx.status(`${def.label}：${o.label}`, 'ok');
      },
    })),
  );
}
