// The 39-byte FZUI record is expanded by 0x2dcaa0 into 136 bytes at actor+0x2bc.
export function motionSettings(bytes, bank, motion, clipEnd, tick) {
  if (![0,1].includes(bank) || !Number.isInteger(motion) || motion < 0 ||
      motion >= (bank ? 2088 : 873) || bytes.length !== 39 * (2088 + 873)) {
    throw new RangeError("Invalid motion settings record");
  }
  let bit = ((bank === 1 ? 0 : 2088) + motion) * 39 * 8;
  function read(width) {
    let value = 0;
    for (let n = 0; n < width; n++,bit++) value = value * 2 + ((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1);
    return value;
  }
  const words = new Uint32Array(34);
  const floats = new Float32Array(words.buffer);
  const spans = [11,11,11,11,11,11,11,11,11,11,3,7,4,11,2,5,11,2];
  spans.forEach((width, i) => words[12+i] = read(width));
  for (let i = 30; i <= 32; i++) floats[i] = Math.fround(read(8) * Math.fround(0.01));
  words[33] = read(16);
  for (let group = 0; group < 4; group++) {
    words[group*3] = read(11);
    words[group*3+1] = read(11);
    words[group*3+2] = read(7);
  }
  // 0x2e4900 fixes up open-ended intervals against the actual loaded clip.
  for (const i of [12,13]) if (words[i] === 2047) words[i] = Math.trunc(clipEnd);
  if (words[17] !== 2047 && words[18] === 2047) words[18] = Math.trunc(clipEnd);
  if (words[25] === 2047) words[25] = Math.trunc(Math.fround(clipEnd - tick));
  return words;
}
