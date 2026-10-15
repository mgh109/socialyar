import {test} from "node:test";
import assert from "node:assert/strict";
import {persianError,diagnosticErrorCode} from "../../web/app/lib/persian";
test("storage permission failures never recommend reconnecting the YouTube account",()=>{
  for(const code of ["EACCES","EPERM","EROFS"]){const text=`${code}: permission denied, open '/private/video'`;assert.match(persianError(text),/ذخیره/);assert.equal(diagnosticErrorCode(text),code);}
  assert.match(persianError("ENOSPC: no space left on device"),/پر شده/);
});
test("technical diagnostics expose known codes without leaking credentials or paths",()=>{
  assert.equal(diagnosticErrorCode("Google HTTP 403: forbidden https://example.com/?token=secret"),"HTTP 403");
  assert.equal(diagnosticErrorCode("https://example.com/?token=secret"),null);
});
