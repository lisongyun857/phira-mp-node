/**
 * 与 phira-mp-common 的 BinaryReader / BinaryWriter 等价的实现。
 * 所有多字节整数均为小端序，长度前缀为 ULEB128。
 */

export class BinaryWriter {
  constructor(size = 256) {
    this.buf = Buffer.allocUnsafe(size);
    this.pos = 0;
  }

  _ensure(n) {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let size = this.buf.length || 64;
    while (size < need) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  u8(v) {
    this._ensure(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  i8(v) {
    return this.u8(v);
  }

  bool(v) {
    return this.u8(v ? 1 : 0);
  }

  u16(v) {
    this._ensure(2);
    this.buf.writeUInt16LE(v & 0xffff, this.pos);
    this.pos += 2;
    return this;
  }

  u32(v) {
    this._ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.pos);
    this.pos += 4;
    return this;
  }

  i32(v) {
    this._ensure(4);
    this.buf.writeInt32LE(v | 0, this.pos);
    this.pos += 4;
    return this;
  }

  f32(v) {
    this._ensure(4);
    this.buf.writeFloatLE(v, this.pos);
    this.pos += 4;
    return this;
  }

  bytes(data) {
    this._ensure(data.length);
    data.copy(this.buf, this.pos);
    this.pos += data.length;
    return this;
  }

  uleb(v) {
    let n = Number(v);
    do {
      let byte = n & 0x7f;
      n = Math.floor(n / 128);
      if (n !== 0) byte |= 0x80;
      this.u8(byte);
    } while (n !== 0);
    return this;
  }

  str(s) {
    const data = Buffer.from(String(s), 'utf8');
    this.uleb(data.length);
    return this.bytes(data);
  }

  array(items, writeElement) {
    this.uleb(items.length);
    for (const item of items) writeElement(this, item);
    return this;
  }

  option(value, writeValue) {
    if (value === null || value === undefined) return this.bool(false);
    this.bool(true);
    writeValue(this, value);
    return this;
  }

  /** 对应 Rust 的 Result<T, String> */
  result(res, writeOk) {
    this.bool(res.ok);
    if (res.ok) writeOk(this, res.value);
    else this.str(res.error);
    return this;
  }

  finish() {
    return Buffer.from(this.buf.subarray(0, this.pos));
  }
}

export class BinaryReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  _take(n) {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('unexpected EOF');
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  u8() {
    return this._take(1)[0];
  }

  i8() {
    return this._take(1).readInt8(0);
  }

  bool() {
    return this.u8() === 1;
  }

  u16() {
    return this._take(2).readUInt16LE(0);
  }

  u32() {
    return this._take(4).readUInt32LE(0);
  }

  i32() {
    return this._take(4).readInt32LE(0);
  }

  f32() {
    return this._take(4).readFloatLE(0);
  }

  take(n) {
    return this._take(n);
  }

  uleb() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 32) throw new Error('invalid uleb');
    }
  }

  str() {
    const len = this.uleb();
    return this._take(len).toString('utf8');
  }

  array(readElement) {
    const count = this.uleb();
    // 粗略防御：每个元素至少 1 字节
    if (count > this.buf.length - this.pos) throw new Error('invalid array length');
    const out = new Array(count);
    for (let i = 0; i < count; i += 1) out[i] = readElement(this);
    return out;
  }

  option(readValue) {
    return this.bool() ? readValue(this) : null;
  }
}
