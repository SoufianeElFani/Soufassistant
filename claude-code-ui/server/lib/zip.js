/*
 * A minimal ZIP reader and writer — enough to hand a skill folder back as a
 * .zip the user can upload to claude.ai, to take one in (Skills → Import), and
 * to open and rewrite Office files (office-edit.js: .docx/.pptx/.xlsx are ZIPs
 * of XML). STORE or DEFLATE through node's own zlib; no ZIP64, no encryption.
 * No dependency: the runtime manifest stays the SDK + express + ws.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { inflateRawSync, deflateRawSync } from 'zlib';
import path from 'path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * files: [{ name: 'dir/file.md', data: Buffer, mtime?: Date }] → Buffer (.zip)
 * `deflate: true` compresses every entry (Office files are expected to be).
 */
export function makeZip(files, { deflate = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data));
    const crc = crc32(raw);
    const method = deflate ? 8 : 0;
    const data = deflate ? deflateRawSync(raw) : raw;
    const { time, date } = dosTime(f.mtime || new Date());
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 30); ch.writeUInt32LE(0, 34);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Read a .zip → [{ name, data: Buffer }] in archive order (directories
 * skipped). Throws on what it does not handle (ZIP64, encryption, a method
 * other than STORE/DEFLATE) or on a damaged archive.
 */
export function readZip(buf, { maxBytes = 200 * 1024 * 1024 } = {}) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged ZIP (central directory)');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString(flags & 0x0800 ? 'utf8' : 'latin1');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Encrypted ZIP entries are not supported');
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('Damaged ZIP (local header)');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const comp = buf.slice(start, start + csize);
    total += usize;
    if (total > maxBytes) throw new Error('ZIP too large');
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = inflateRawSync(comp);
    else throw new Error(`ZIP method ${method} is not supported`);
    out.push({ name, data });
  }
  return out;
}

/** Every file under `dir` (dotfiles skipped), named `${prefix}/relative/path`. */
export function zipDirectory(dir, prefix, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const files = [];
  let total = 0;
  const walk = (abs, rel) => {
    for (const n of readdirSync(abs).sort()) {
      if (n.startsWith('.')) continue;
      const p = path.join(abs, n);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p, `${rel}/${n}`); continue; }
      if (!st.isFile()) continue;
      total += st.size;
      if (total > maxBytes) throw new Error('Skill folder too large to export');
      files.push({ name: `${rel}/${n}`, data: readFileSync(p), mtime: st.mtime });
    }
  };
  walk(dir, prefix);
  return makeZip(files);
}
