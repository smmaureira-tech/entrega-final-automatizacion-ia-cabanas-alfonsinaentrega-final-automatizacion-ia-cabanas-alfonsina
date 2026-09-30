// Genera icon-192.png e icon-512.png (anillo de progreso) sin dependencias.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function icon(size) {
  const bg = [0x27, 0x36, 0x8a], S = 4; // 4x4 supermuestreo
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const cx = size / 2, r = size * 0.254, w = size * 0.086;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = x + (sx + .5) / S - cx, py = y + (sy + .5) / S - cx;
        const d = Math.hypot(px, py);
        const ang = (Math.atan2(py, px) * 180 / Math.PI + 360) % 360; // 0 = derecha, sentido horario
        const onRing = Math.abs(d - r) <= w / 2;
        // arco lleno de 270° (desde arriba en sentido horario hasta la izquierda)
        const full = ang >= 270 || ang <= 180;
        a += onRing ? (full ? 1 : 0.28) : 0;
      }
      a /= S * S;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(bg[i] + (255 - bg[i]) * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [192, 512]) fs.writeFileSync(path.join(__dirname, '..', `icon-${s}.png`), icon(s));
