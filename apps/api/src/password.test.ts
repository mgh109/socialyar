import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone,hashPassword,verifyPassword } from './password';
test('Iranian mobile representations normalize to one identity',()=>{
 const expected='+989121234567';for(const value of ['09121234567','۰۹۱۲۱۲۳۴۵۶۷','٠٩١٢١٢٣٤٥٦٧','00989121234567','+98 (912) 123-4567','9121234567'])assert.equal(normalizePhone(value),expected);
 assert.equal(normalizePhone('+44 7700 900123'),'+447700900123');
});
test('invalid mobile identities cannot be silently accepted',()=>{
 for(const value of ['','0912','user@example.com','+0989121234567','++989121234567','+98912<script>','09121234567 ext 3'])assert.throws(()=>normalizePhone(value));
});
test('password salts differ and only the matching password verifies',async()=>{
 const first=await hashPassword('a strong test password'),second=await hashPassword('a strong test password');assert.notEqual(first,second);
 assert.equal(await verifyPassword('a strong test password',first),true);assert.equal(await verifyPassword('a wrong password',first),false);
 for(const invalid of ['','sha256$x$abcd','scrypt$x$not-hex','scrypt$x$00'])assert.equal(await verifyPassword('any',invalid),false);
});
