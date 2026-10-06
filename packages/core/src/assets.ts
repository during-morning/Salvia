/**
 * Assets embedded in the single-file build (Node SEA). In a normal Node run there are none and
 * callers fall back to files on disk.
 */

interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
  getAssetKeys?(): string[];
}

let sea: SeaModule | null | undefined;

function seaModule(): SeaModule | null {
  if (sea === undefined) {
    try {
      const mod = process.getBuiltinModule?.('node:sea') as SeaModule | undefined;
      sea = mod?.isSea() ? mod : null;
    } catch {
      sea = null;
    }
  }
  return sea;
}

/** True when running as the packaged salvia executable. */
export function isPackaged(): boolean {
  // Worker threads can't ask node:sea; the loader marks the process for them.
  return process.env.SALVIA_PACKAGED === '1' || seaModule() !== null;
}

export function packagedAsset(key: string): Buffer | undefined {
  const s = seaModule();
  if (!s) return undefined;
  try {
    return Buffer.from(s.getAsset(key));
  } catch {
    return undefined;
  }
}

export function packagedKeys(prefix = ''): string[] {
  return (seaModule()?.getAssetKeys?.() ?? []).filter((k) => k.startsWith(prefix));
}
