import type { LoginSite } from './browser.ts';
import type { ArgOption, Command, Handler } from './session.ts';
import type { SettingDef } from './settings.ts';

/**
 * Salvia is assembled from modules. Core knows no site: every platform (B站, 网易云, 抖音 …) is a
 * module that registers what it brings — the links and ids it recognises, its login page, its
 * network (for @proxy and the reachability check), its handlers and commands — and fills the
 * capability slots that feature modules (video, music, anime, novel) define.
 *
 * Dependency direction: core ← media ← features ← platforms ← app. A feature never imports a
 * platform; it asks the registry for whatever fills its slots.
 */

export type LinkKind = 'video' | 'music';

/** A typed slot: a feature declares it, platform modules provide values for it. */
export interface Slot<T> {
  readonly id: string;
  /** Type carrier only. */
  readonly _type?: T;
}

export function slot<T>(id: string): Slot<T> {
  return { id };
}

/** Links on these hosts open with the given site's handler. */
export interface HostRule {
  pattern: RegExp;
  /** Only links whose path matches (B站 /audio/ is music, the rest of bilibili.com video). */
  path?: RegExp;
  kind: LinkKind;
  site: string;
}

/** A bare id (BV号, YouTube id, 网易云歌曲号 …), as typed or after `@parse:<platform>`. */
export interface IdRule {
  pattern: RegExp;
  kind: LinkKind;
  site: string;
  /** The link the id stands for. */
  link(id: string): string;
  /** Recognised with this `@parse:<platform>` hint (canonical platform id). */
  platform?: string;
  /** Also recognised without a hint; lower runs first among those (negative: even without @parse). */
  bare?: number;
  /** What it is called in hints ("BV号", "网易云歌曲号"). */
  label?: string;
}

/** A target of `@music:<id>` / `@video:<id>`. */
export interface PlatformInfo {
  type: 'music' | 'video';
  id: string;
  name: string;
  /** Other spellings (the id itself is always accepted). */
  aliases?: string[];
}

/** A site's network: what @proxy calls it, which hosts that covers, how to check it answers. */
export interface SiteNet {
  id: string;
  name: string;
  hosts: RegExp;
  /** A cheap URL that answers when the site is reachable (checked at start-up). */
  probe?: string;
  /** Only answers mainland-China networks. */
  region?: 'cn';
  /** Opened in the background at start-up, so the first request is fast. */
  prewarm?: string[];
}

export interface SalviaModule {
  id: string;
  setup(api: ModuleApi): void;
}

export interface ModuleApi {
  handler(h: Handler): void;
  command(c: Command): void;
  /** `@<type>:<target>` values that aren't commands (book sources for @novel:). */
  targets(type: string, list: () => ArgOption[]): void;
  host(rule: HostRule): void;
  id(rule: IdRule): void;
  platform(p: PlatformInfo): void;
  /** `@login <id>`; `aliases` are other spellings, and the item `locked.site` values that mean it. */
  login(id: string, site: LoginSite, aliases?: string[]): void;
  site(s: SiteNet): void;
  setting(def: SettingDef): void;
  provide<T>(slot: Slot<T>, value: T): void;
  /** Background set-up for interactive use (device cookies, tokens …). */
  warm(fn: () => void): void;
}

class Registry {
  readonly modules = new Set<string>();
  readonly handlers: Handler[] = [];
  readonly commands = new Map<string, Command>();
  readonly targets = new Map<string, () => ArgOption[]>();
  readonly hosts: HostRule[] = [];
  readonly ids: IdRule[] = [];
  readonly platforms: PlatformInfo[] = [];
  readonly logins = new Map<string, LoginSite>();
  readonly loginAliases = new Map<string, string>();
  readonly sites = new Map<string, SiteNet>();
  readonly settings: SettingDef[] = [];
  readonly warmers: (() => void)[] = [];
  private readonly slots = new Map<string, unknown[]>();
  /** Bumped on every change, for caches derived from the registry. */
  version = 0;

  install(m: SalviaModule): void {
    if (this.modules.has(m.id)) return;
    this.modules.add(m.id);
    const touch = <T>(fn: (v: T) => void) => (v: T) => {
      fn(v);
      this.version++;
    };
    m.setup({
      handler: touch((h) => this.handlers.push(h)),
      command: touch((c) => this.commands.set(c.name, c)),
      targets: (type, list) => {
        this.targets.set(type, list);
        this.version++;
      },
      host: touch((r) => this.hosts.push(r)),
      id: touch((r) => this.ids.push(r)),
      platform: touch((p) => this.platforms.push(p)),
      login: (id, site, aliases = []) => {
        this.logins.set(id, site);
        for (const a of aliases) this.loginAliases.set(a.toLowerCase(), id);
        this.version++;
      },
      site: touch((s) => this.sites.set(s.id, s)),
      setting: touch((d) => this.settings.push(d)),
      provide: (s, value) => {
        const list = this.slots.get(s.id) ?? [];
        list.push(value);
        this.slots.set(s.id, list);
        this.version++;
      },
      warm: (fn) => this.warmers.push(fn),
    });
  }

  provided<T>(s: Slot<T>): T[] {
    return (this.slots.get(s.id) as T[] | undefined) ?? [];
  }

  platformsOf(type: 'music' | 'video'): PlatformInfo[] {
    return this.platforms.filter((p) => p.type === type);
  }

  /** Canonical platform id for what was typed after `@music:` / `@video:`. */
  resolvePlatform(type: 'music' | 'video', name: string): string | undefined {
    const n = name.toLowerCase();
    return this.platformsOf(type).find((p) => p.id === n || p.aliases?.some((a) => a.toLowerCase() === n))?.id;
  }

  platformName(id: string): string {
    return this.platforms.find((p) => p.id === id)?.name ?? id;
  }

  /** `@login` id for what the user typed, or for an item's `locked.site`. */
  loginId(input: string | undefined): string | undefined {
    const key = (input ?? '').trim().toLowerCase();
    if (this.logins.has(key)) return key;
    return this.loginAliases.get(key);
  }

  /** For tests: forget everything. */
  reset(): void {
    this.modules.clear();
    this.handlers.length = 0;
    this.commands.clear();
    this.targets.clear();
    this.hosts.length = 0;
    this.ids.length = 0;
    this.platforms.length = 0;
    this.logins.clear();
    this.loginAliases.clear();
    this.sites.clear();
    this.settings.length = 0;
    this.warmers.length = 0;
    this.slots.clear();
    this.version++;
  }
}

/** The process-wide registry: modules are installed once, every session uses them. */
export const registry = new Registry();

export function install(...modules: SalviaModule[]): void {
  for (const m of modules) registry.install(m);
}

export function provided<T>(s: Slot<T>): T[] {
  return registry.provided(s);
}
