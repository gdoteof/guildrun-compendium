/**
 * Raw-log storage abstraction. Content-addressed: key = sha256 of the scrubbed
 * file text, so identical files are stored once no matter who uploads them.
 *
 * KV backend is in use today; the R2 backend below is ready and becomes the
 * default the moment R2 is enabled on the account (one-line swap in index.ts).
 * Raw storage is the ground-truth layer: facts are rebuilt from it whenever
 * the parser improves.
 */

export interface RawStore {
  put(hash: string, text: string): Promise<void>;
  get(hash: string): Promise<string | null>;
  list(cursor?: string): Promise<{ hashes: string[]; cursor?: string }>;
}

const PREFIX = "raw:";

export class KVRawStore implements RawStore {
  constructor(private kv: KVNamespace) {}

  async put(hash: string, text: string): Promise<void> {
    await this.kv.put(PREFIX + hash, text);
  }

  async get(hash: string): Promise<string | null> {
    return this.kv.get(PREFIX + hash, "text");
  }

  async list(cursor?: string): Promise<{ hashes: string[]; cursor?: string }> {
    const res = await this.kv.list({ prefix: PREFIX, cursor });
    return {
      hashes: res.keys.map((k) => k.name.slice(PREFIX.length)),
      cursor: res.list_complete ? undefined : res.cursor,
    };
  }
}

export class R2RawStore implements RawStore {
  constructor(private bucket: R2Bucket) {}

  async put(hash: string, text: string): Promise<void> {
    await this.bucket.put(hash, text);
  }

  async get(hash: string): Promise<string | null> {
    const obj = await this.bucket.get(hash);
    return obj ? obj.text() : null;
  }

  async list(cursor?: string): Promise<{ hashes: string[]; cursor?: string }> {
    const res = await this.bucket.list({ cursor });
    return {
      hashes: res.objects.map((o) => o.key),
      cursor: res.truncated ? res.cursor : undefined,
    };
  }
}
