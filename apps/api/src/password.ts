import { randomBytes, scrypt as callback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(callback);
export function normalizePhone(value: string) {
  let phone = value.trim().replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[\s()-]/g, '');
  if (phone.startsWith('0098')) phone = '+98' + phone.slice(4);
  else if (phone.startsWith('09')) phone = '+98' + phone.slice(1);
  else if (/^9\d{9}$/.test(phone)) phone = '+98' + phone;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('شماره موبایل معتبر نیست.');
  return phone;
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm,salt,hash] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !/^(?:[a-f0-9]{64}|[a-f0-9]{128})$/.test(hash ?? '')) return false;
  const expected=Buffer.from(hash,'hex'); const actual=await scrypt(password,salt,expected.length) as Buffer;
  return timingSafeEqual(actual,expected);
}
