/**
 * CRC-16/XMODEM as used by the device for `/files` `action:"hash"` and `expected_hash`:
 * polynomial 0x1021, init 0x0000, no reflection, no final XOR.
 */
export function crc16Xmodem(data: Uint8Array, crc = 0): number {
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
