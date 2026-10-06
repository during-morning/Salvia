import { describe, expect, it, vi } from 'vitest';

const getJson = vi.fn();
vi.mock('@salvia/core', async (orig) => ({ ...(await orig<typeof import('@salvia/core')>()), getJson: (...a: unknown[]) => getJson(...a) }));

const { bangumiSearch } = await import('../src/bangumi.ts');

describe('bangumiSearch', () => {
  it('falls back to the older search endpoint when v0 fails (it answers 500 now and then)', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.includes('/v0/')) throw new Error('HTTP 500');
      return { list: [{ id: 400602, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲', air_date: '', eps_count: 28 }] };
    });
    const r = await bangumiSearch('芙莉莲');
    expect(r).toEqual([{ id: 400602, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲', date: undefined, eps: 28, images: undefined }]);
    expect(getJson.mock.calls[1]![0]).toContain('/search/subject/%E8%8A%99%E8%8E%89%E8%8E%B2?type=2');
  });
});
