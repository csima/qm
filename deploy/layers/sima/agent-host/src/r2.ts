const PART_SIZE = 8 * 1024 * 1024;

export class PartBuffer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private readonly partSize: number;

  constructor(partSize: number) {
    this.partSize = partSize;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const parts: Uint8Array[] = [];
    while (this.size >= this.partSize) parts.push(this.take(this.partSize));
    return parts;
  }

  rest(): Uint8Array {
    return this.take(this.size);
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const used = Math.min(head.length, n - offset);
      out.set(head.subarray(0, used), offset);
      offset += used;
      if (used === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(used);
    }
    this.size -= n;
    return out;
  }
}

export async function putStream(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  partSize = PART_SIZE,
): Promise<number> {
  const reader = stream.getReader();
  const buffer = new PartBuffer(partSize);
  const parts: R2UploadedPart[] = [];
  let upload: R2MultipartUpload | undefined;
  let total = 0;
  const send = async (part: Uint8Array) => {
    upload ??= await bucket.createMultipartUpload(key);
    parts.push(await upload.uploadPart(parts.length + 1, part));
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      for (const part of buffer.push(value)) await send(part);
    }
    const rest = buffer.rest();
    if (!upload) {
      await bucket.put(key, rest);
      return total;
    }
    if (rest.length) await send(rest);
    await upload.complete(parts);
    return total;
  } catch (error) {
    await upload?.abort().catch(() => undefined);
    throw error;
  }
}
