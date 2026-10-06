import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Session, TaskQueue, getSetting, loadConfig, resetConfigCache, saveConfig, setSetting, uiPrefs } from '../src/index.ts';

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'salvia-store-'));
  process.env.SALVIA_HOME = home;
  resetConfigCache();
});

describe('database', () => {
  it('imports the old config.json once, then keeps cookies in the database', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ downloadDir: '/music', cookies: { bili: 'SESSDATA=1' }, extra: { a: 1 } }));
    expect(loadConfig()).toMatchObject({ downloadDir: '/music', cookies: { bili: 'SESSDATA=1' }, extra: { a: 1 } });
    saveConfig({ cookies: { netease: 'MUSIC_U=2' } });
    resetConfigCache();
    expect(loadConfig().cookies).toEqual({ netease: 'MUSIC_U=2' });
  });

  it('records finished downloads and forgets them', async () => {
    const session = new Session(new TaskQueue());
    session.queue.add({ kind: 'music', title: '晴天', run: async () => '/tmp/晴天.mp3' });
    await new Promise((r) => setTimeout(r, 30));
    const [rec] = session.downloads();
    expect(rec).toMatchObject({ title: '晴天', status: 'done', path: '/tmp/晴天.mp3' });
    await session.forgetDownload(rec!.id);
    expect(session.downloads()).toEqual([]);
    session.dispose();
  });
});

describe('settings', () => {
  it('validates values and accepts labels', () => {
    expect(getSetting('theme')).toBe('salvia');
    expect(setSetting('theme', '薄荷绿')).toBeUndefined();
    expect(getSetting('theme')).toBe('mint');
    expect(uiPrefs().accent).toBe('#5fc4a0');
    expect(setSetting('connections', '7')).toContain('线程');
    expect(setSetting('nosuch', '1')).toContain('没有设置项');
    expect(setSetting('concurrency', '4')).toBeUndefined();
    expect(loadConfig().concurrency).toBe(4);
  });

  it('@setting lists the settings as a table and changes one from its options', async () => {
    const session = new Session(new TaskQueue());
    const { registerCoreCommands } = await import('../src/index.ts');
    registerCoreCommands(session);
    await session.input('@setting');
    expect(session.view().columns?.map((c) => c.title)).toEqual(['分组', '设置', '当前']);
    await session.pick('set:listStyle');
    await session.pick('opt:compact');
    expect(getSetting('listStyle')).toBe('compact');
    expect(session.view().prefs?.table).toBe(false);
    session.dispose();
  });
});
