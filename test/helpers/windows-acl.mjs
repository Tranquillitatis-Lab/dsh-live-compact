import assert from "node:assert/strict";
import { win32Tool } from "../../shadow.js";

// Offline transport/structure checks only. This does not execute PowerShell or
// prove Windows access denial; the coordinator's two-user hosted probe does.
export function windowsAclCall(file, args, options, env, sid) {
  assert.equal(file, win32Tool("WindowsPowerShell\\v1.0\\powershell.exe", env));
  assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(args.length, 5);
  const script = Buffer.from(args[4], "base64").toString("utf16le");
  assert.match(script, /DirectorySecurity\]::new\(\)/);
  assert.match(script, /FileSecurity\]::new\(\)/);
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
  assert.match(script, /AreAccessRulesProtected/);
  assert.match(script, /GetAccessRules\(\$true, \$true,/);
  assert.match(script, /DSH_SHADOW_ACL_OK/);
  assert.doesNotMatch(script, /icacls|SetOwner|SetGroup|SetAuditRule|Start-Process|Invoke-Expression|Set-Acl|Get-Acl/i);
  assert.ok(script.indexOf("SetAccessRuleProtection") < script.indexOf("::SetAccessControl"));
  assert.ok(script.indexOf("::SetAccessControl") < script.indexOf("::GetAccessControl"));
  assert.ok(script.indexOf("::GetAccessControl") < script.indexOf("DSH_SHADOW_ACL_OK"));
  assert.equal(options.env.DSH_SHADOW_ACL_SID, sid);
  assert.ok(["dir", "file"].includes(options.env.DSH_SHADOW_ACL_KIND));
  assert.equal(options.windowsHide, true);
  assert.equal(options.encoding, "utf8");
  assert.equal(options.stdio, "pipe");
  assert.equal(options.timeout, 15000);
  assert.equal(options.maxBuffer, 65536);
  return {
    script,
    path: options.env.DSH_SHADOW_ACL_PATH,
    kind: options.env.DSH_SHADOW_ACL_KIND,
  };
}
