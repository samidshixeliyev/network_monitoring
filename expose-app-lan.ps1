# Expose the dev frontend (Vite :5173) to the LAN. The WSL mirrored relay already
# holds loopback :5173, so a portproxy can't bind :5173 — listen on host :5273
# instead. LAN 0.0.0.0:5273 -> 127.0.0.1:5173 (WSL mirrored -> Vite).
$log = "$PSScriptRoot\expose-app-lan.log"
"" | Set-Content $log
function L($m){ $m | Tee-Object -FilePath $log -Append }
try {
  L "[*] portproxy 0.0.0.0:5273 -> 127.0.0.1:5173"
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5173 2>&1 | Out-Null
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5273 2>&1 | Out-Null
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5273 connectaddress=127.0.0.1 connectport=5173 2>&1 | Tee-Object -FilePath $log -Append
  L "[*] firewall: allow inbound TCP 5273"
  Get-NetFirewallRule -DisplayName "Netmon frontend 5173" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName "Netmon frontend 5273" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName "Netmon frontend 5273" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5273 -Profile Any | Out-Null
  L "[*] portproxy table:"
  netsh interface portproxy show v4tov4 2>&1 | Tee-Object -FilePath $log -Append
  L "[OK] done"
} catch { L "[ERR] $_" }
