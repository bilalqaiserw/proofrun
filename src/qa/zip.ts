import { inflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { inventory, MAX_PROJECT_BYTES } from "./projects.ts";
import { inside, safePath } from "./safety.ts";
import { PROJECT_LIMITS } from "../../public/project-limits.js";
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data: Buffer) {
  let c = 0xffffffff;
  for (const byte of data) c = table[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export async function exportZip(root: string) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  const files = await inventory(root);
  for (const file of files) {
    const name = Buffer.from(file.path),
      data = await readFile(inside(root, file.path));
    const crc = crc32(data),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const item = Buffer.alloc(46);
    item.writeUInt32LE(0x02014b50);
    item.writeUInt16LE(20, 4);
    item.writeUInt16LE(20, 6);
    item.writeUInt16LE(0x800, 8);
    item.writeUInt32LE(crc, 16);
    item.writeUInt32LE(data.length, 20);
    item.writeUInt32LE(data.length, 24);
    item.writeUInt16LE(name.length, 28);
    item.writeUInt32LE(offset, 42);
    central.push(item, name);
    offset += header.length + name.length + data.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
export function importZip(buffer: Buffer) {
  if (buffer.length > MAX_PROJECT_BYTES) throw new Error("ZIP exceeds 128 MB");
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("Invalid ZIP archive");
  const count = buffer.readUInt16LE(end + 10),
    cd = buffer.readUInt32LE(end + 16);
  if (
    count > 2000 ||
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0
  )
    throw new Error("Split/ZIP64 or oversized archives are not supported");
  const files: any[] = [];
  let p = cd,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50)
      throw new Error("Invalid ZIP directory");
    const flags = buffer.readUInt16LE(p + 8),
      method = buffer.readUInt16LE(p + 10),
      crc = buffer.readUInt32LE(p + 16),
      packed = buffer.readUInt32LE(p + 20),
      size = buffer.readUInt32LE(p + 24),
      nameLen = buffer.readUInt16LE(p + 28),
      extra = buffer.readUInt16LE(p + 30),
      comment = buffer.readUInt16LE(p + 32),
      attrs = buffer.readUInt32LE(p + 38),
      start = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extra + comment;
    safePath(name.endsWith("/") ? name.slice(0, -1) : name);
    if (name.endsWith("/")) continue;
    if (flags & 1 || ((attrs >>> 16) & 0xf000) === 0xa000)
      throw new Error("Encrypted files and symlinks are not supported");
    total += size;
    if (
      size > PROJECT_LIMITS.maxFileBytes ||
      total > MAX_PROJECT_BYTES ||
      start + 30 > buffer.length ||
      buffer.readUInt32LE(start) !== 0x04034b50
    )
      throw new Error("ZIP exceeds safe extraction limits");
    const dataStart =
      start +
      30 +
      buffer.readUInt16LE(start + 26) +
      buffer.readUInt16LE(start + 28);
    if (dataStart + packed > buffer.length) throw new Error("Truncated ZIP");
    const compressed = buffer.subarray(dataStart, dataStart + packed);
    const data =
      method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed, {
              maxOutputLength: PROJECT_LIMITS.maxFileBytes,
            })
          : null;
    if (!data || data.length !== size || crc32(data) !== crc)
      throw new Error("Unsupported or corrupted ZIP member");
    files.push({ path: name, base64: data.toString("base64") });
  }
  const first = files[0]?.path.split("/")[0];
  if (first && files.every((f) => f.path.startsWith(first + "/")))
    for (const file of files) file.path = file.path.slice(first.length + 1);
  return files;
}
