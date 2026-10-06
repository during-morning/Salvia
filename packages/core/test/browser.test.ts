import { describe, expect, it } from 'vitest';
import { cookieHeader } from '../src/browser.ts';
import { registerCoreCommands } from '../src/commands.ts';
import { Session } from '../src/session.ts';
import { TaskQueue } from '../src/queue.ts';

const c = (name: string, value: string, domain: string, expires = 0) => ({ name, value, domain, expires });

describe('cookieHeader', () => {
  it('keeps the site and its subdomains only, longest-living duplicate wins', () => {
    const header = cookieHeader(
      [
        c('SESSDATA', 'abc', '.bilibili.com', 100),
        c('bili_jct', 'x', 'www.bilibili.com'),
        c('SESSDATA', 'old', 'passport.bilibili.com', 50),
        c('NID', 'g', '.google.com'),
        c('fake', 'n', 'notbilibili.com'),
      ],
      ['bilibili.com'],
    );
    expect(header).toBe('SESSDATA=abc; bili_jct=x');
  });
});

describe('@cookie', () => {
  it('points to @login', async () => {
    const session = new Session(new TaskQueue());
    registerCoreCommands(session);
    let view = session.view();
    session.on('view', (v) => (view = v));
    await session.input('@cookie');
    await new Promise((r) => setTimeout(r, 80));
    expect(view.status.text).toContain('推荐用 @login');
    expect(session.commandList().find((c) => c.name === 'cookie')?.usage).toContain('推荐用 @login');
  });
});
