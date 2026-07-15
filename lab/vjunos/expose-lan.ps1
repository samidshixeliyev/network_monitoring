# Expose vJunos SSH to the LAN via Windows portproxy + firewall.
# LAN 172.22.111.11:2223 -> WSL 127.0.0.1:2222 (mirrored) -> QEMU -> guest fxp0:22
# Port 2223 is used on the host because WSL mirrored-mode relay already holds
# loopback :2222, which blocks a portproxy from binding :2222.
$log = "$PSScriptRoot\expose-lan.log"
"" | Set-Content $log
function L($m){ $m | Tee-Object -FilePath $log -Append }
try {
  L "[*] clearing old :2222 / :2223 portproxy entries"
  netsh interface portproxy delete v4tov4 listenaddress=172.22.111.11 listenport=2222 2>&1 | Out-Null
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=2222 2>&1 | Out-Null
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=2223 2>&1 | Out-Null
  L "[*] add portproxy 0.0.0.0:2223 -> 127.0.0.1:2222"
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=2223 connectaddress=127.0.0.1 connectport=2222 2>&1 | Tee-Object -FilePath $log -Append
  L "[*] firewall: allow inbound TCP 2223 (remove old 2222 rule)"
  Get-NetFirewallRule -DisplayName "vJunos SSH 2222" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName "vJunos SSH 2223" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName "vJunos SSH 2223" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 2223 -Profile Any | Out-Null
  L "[*] portproxy table:"
  netsh interface portproxy show v4tov4 2>&1 | Tee-Object -FilePath $log -Append
  L "[*] host listener on 2223:"
  (netstat -ano | Select-String ':2223') 2>&1 | Tee-Object -FilePath $log -Append
  L "[OK] done"
} catch { L "[ERR] $_" }
