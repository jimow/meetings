'use strict';

// Minimal PNG/JPEG dimension reader (no dependency). Returns { width, height, type } or null.
function imageSize(buf) {
  if (!buf || buf.length < 4) return null;

  // PNG: 89 50 4E 47 ... IHDR width@16 height@20
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
  }

  // JPEG: FF D8 ... scan for Start-Of-Frame markers
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // Standalone markers (no length payload)
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        return { width, height, type: 'jpeg' };
      }
      off += 2 + len;
    }
  }
  return null;
}

module.exports = { imageSize };
