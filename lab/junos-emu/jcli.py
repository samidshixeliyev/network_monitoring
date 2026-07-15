#!/usr/bin/env python3
"""
Minimal Junos CLI emulator — the login shell for the lab "vJunos" device.

It is NOT real Junos, but it makes the web terminal behave like Junos gear:
an operational prompt (`user@host>`), a configuration mode (`user@host#`) with
`set` / `delete` / `commit`, and the common `show` commands — instead of the
bare Alpine shell. Candidate/committed config is persisted to a file so `set`
+ `commit` + `show configuration` stay consistent across sessions.

Runs two ways (standard login-shell contract):
  * interactive (no args / login shell)  → REPL with prompts
  * `jcli -c "show version"`             → run one command, print, exit
The second form is what the monitor's SSH collector uses, so `show configuration
system host-name | display set` and `show system uptime` return sensible output.
"""
import os
import re
import socket
import sys
import time

HOST = socket.gethostname()
MODEL = os.environ.get("JUNOS_MODEL", "vjunos-router")
VERSION = os.environ.get("JUNOS_VERSION", "23.4R1.10")
USER = os.environ.get("USER") or "root"
COMMIT_FILE = "/var/lib/jcli/committed.set"
BOOT_FILE = "/var/run/jcli.boot"


def primary_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "0.0.0.0"


IP = primary_ip()


def boot_epoch() -> float:
    try:
        return float(open(BOOT_FILE).read().strip())
    except Exception:
        return time.time()


def uptime_short() -> str:
    secs = max(0, int(time.time() - boot_epoch()))
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    return (f"{d}d " if d else "") + f"{h:02d}:{m:02d}"


def default_config() -> list[str]:
    return [
        f"set system host-name {HOST}",
        "set system root-authentication encrypted-password (hashed)",
        "set system services ssh",
        "set system services netconf ssh",
        "set snmp community public authorization read-only",
        "set snmp community public clients 172.30.0.0/24",
        f"set interfaces ge-0/0/0 unit 0 family inet address {IP}/24",
        "set interfaces lo0 unit 0 family inet address 127.0.0.1/32",
        "set routing-options static route 0.0.0.0/0 next-hop 172.30.0.1",
    ]


def read_committed() -> list[str]:
    try:
        lines = [l.rstrip("\n") for l in open(COMMIT_FILE) if l.strip()]
        return lines or default_config()
    except Exception:
        return default_config()


def write_committed(lines: list[str]) -> None:
    os.makedirs(os.path.dirname(COMMIT_FILE), exist_ok=True)
    with open(COMMIT_FILE, "w") as f:
        f.write("\n".join(lines) + "\n")


# ── config set-statements → hierarchical braces render ───────────────────────
def set_to_tree(lines: list[str]) -> dict:
    tree: dict = {}
    for line in lines:
        if not line.startswith("set "):
            continue
        node = tree
        for tok in line[4:].split():
            node = node.setdefault(tok, {})
    return tree


def render_tree(tree: dict, indent: int = 0) -> list[str]:
    out = []
    pad = "    " * indent
    for k, v in tree.items():
        if v:
            out.append(f"{pad}{k} {{")
            out += render_tree(v, indent + 1)
            out.append(f"{pad}}}")
        else:
            out.append(f"{pad}{k};")
    return out


def show_configuration(args: list[str], cfg: list[str], disp_set: bool) -> str:
    lines = cfg
    if args:
        prefix = "set " + " ".join(args)
        lines = [l for l in cfg if l == prefix or l.startswith(prefix + " ")]
    if disp_set:
        return "\n".join(lines)
    return "\n".join(render_tree(set_to_tree(lines))) or ""


# ── operational-mode command output ──────────────────────────────────────────
def op_show(cmd: str, cfg: list[str], disp_set: bool) -> str:
    if cmd in ("show version", "show ver"):
        return (
            f"Hostname: {HOST}\n"
            f"Model: {MODEL}\n"
            f"Junos: {VERSION}\n"
            f"JUNOS OS 64-bit  [{VERSION}]\n"
            f"JUNOS Software Release [{VERSION}]"
        )
    if cmd.startswith("show system uptime"):
        return (
            f"Current time: {time.strftime('%Y-%m-%d %H:%M:%S UTC')}\n"
            f"System booted: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(boot_epoch()))} "
            f"({uptime_short()} ago)\n"
            f"Protocols started: {uptime_short()} ago"
        )
    if cmd.startswith("show system information"):
        return f"Hardware: {MODEL}\nHostname: {HOST}\nOS: Junos {VERSION}"
    if cmd == "show system alarms":
        return "No alarms currently active"
    if cmd.startswith("show interfaces terse"):
        return (
            "Interface               Admin Link Proto    Local                 Remote\n"
            "ge-0/0/0                up    up\n"
            f"ge-0/0/0.0              up    up   inet     {IP}/24\n"
            "fxp0                    up    up\n"
            "lo0                     up    up\n"
            "lo0.0                   up    up   inet     127.0.0.1           --> 0/0"
        )
    if cmd.startswith("show chassis hardware"):
        return (
            "Item             Version  Part number  Description\n"
            f"Chassis                                {MODEL}\n"
            "Routing Engine 0          BUILTIN      RE-VJUNOS"
        )
    if cmd.startswith("show route"):
        return (
            "inet.0: 3 destinations, 3 routes (3 active, 0 holddown, 0 hidden)\n"
            "+ = Active Route, - = Last Active, * = Both\n\n"
            "0.0.0.0/0          *[Static/5] " + uptime_short() + "\n"
            "                    > to 172.30.0.1 via ge-0/0/0.0\n"
            f"{IP}/24         *[Direct/0] " + uptime_short() + "\n"
            "                    > via ge-0/0/0.0"
        )
    if cmd.startswith("show configuration"):
        rest = cmd[len("show configuration"):].strip()
        return show_configuration(rest.split() if rest else [], cfg, disp_set)
    if cmd in ("show system users", "show cli authorization"):
        return f"{USER} logged in"
    # A few common commands that legitimately have empty output.
    if cmd.startswith(("show ospf", "show bgp", "show arp", "show lldp")):
        return ""
    return None  # signal "unknown"


HELP = """\
Possible completions:
  configure            Manipulate software configuration information
  show                 Show system information
  ping                 Ping a remote target
  quit / exit          Exit the management session
Common show commands:
  show version | show system uptime | show interfaces terse |
  show chassis hardware | show route | show configuration [| display set]"""


def apply_pipes(text: str, pipes: list[str]) -> str:
    for p in pipes:
        p = p.strip()
        if p.startswith("match "):
            pat = p[6:].strip().strip('"')
            text = "\n".join(l for l in text.splitlines() if re.search(pat, l))
        elif p.startswith("except "):
            pat = p[7:].strip().strip('"')
            text = "\n".join(l for l in text.splitlines() if not re.search(pat, l))
        elif p == "count":
            text = f"Count: {len(text.splitlines())} lines"
        elif p.startswith("last "):
            try:
                text = "\n".join(text.splitlines()[-int(p[5:]):])
            except ValueError:
                pass
        # no-more / trim / display: no-op here
    return text


def run_operational(line: str, cfg: list[str]) -> str:
    parts = [p.strip() for p in line.split("|")]
    cmd, pipes = parts[0], parts[1:]
    disp_set = any(p == "display set" for p in pipes)
    if cmd in ("?", "help"):
        return HELP
    if cmd.startswith("ping"):
        target = cmd[4:].strip() or "target"
        return f"PING {target}: 56 data bytes\n64 bytes from {target}: icmp_seq=0 time=0.5 ms\n--- {target} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss"
    if cmd.startswith("show"):
        out = op_show(cmd, cfg, disp_set)
        if out is None:
            return "\nunknown command.\n"
        return apply_pipes(out, [p for p in pipes if p != "display set"])
    if cmd in ("", "cli"):
        return ""
    return "\nunknown command.\n"


# ── interactive REPL ─────────────────────────────────────────────────────────
def repl() -> None:
    committed = read_committed()
    candidate: list[str] | None = None
    mode = "op"
    sys.stdout.write(
        f"--- JUNOS {VERSION} Kernel 64-bit  (lab emulator)\n"
        f"{USER}@{HOST} (ttyp0)\n\n"
    )
    while True:
        prompt = f"{USER}@{HOST}> " if mode == "op" else f"{USER}@{HOST}# "
        try:
            line = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            sys.stdout.write("\n")
            return
        if not line:
            continue

        if mode == "op":
            if line in ("exit", "quit", "logout"):
                return
            if line in ("configure", "configure exclusive", "configure private", "edit"):
                candidate = read_committed()
                mode = "config"
                sys.stdout.write("Entering configuration mode\n\n")
                continue
            sys.stdout.write(run_operational(line, committed) + "\n")
            continue

        # ── configuration mode ──
        if line in ("exit", "quit", "exit configuration-mode", "top") and candidate is not None:
            mode = "op"
            continue
        if line.startswith("run "):
            sys.stdout.write(run_operational(line[4:], committed) + "\n")
            continue
        if line == "show" or line.startswith("show "):
            rest = line[4:].strip()
            disp = rest.endswith("| display set")
            if disp:
                rest = rest[: -len("| display set")].strip()
            args = rest.replace("configuration", "").split() if rest else []
            sys.stdout.write(show_configuration(args, candidate or [], disp) + "\n")
            continue
        if line.startswith("set "):
            if line not in candidate:
                candidate.append(line)
            continue
        if line.startswith("delete "):
            prefix = "set " + line[7:].strip()
            candidate[:] = [l for l in candidate if not (l == prefix or l.startswith(prefix + " "))]
            continue
        if line == "rollback" or line.startswith("rollback"):
            candidate = read_committed()
            sys.stdout.write("load complete\n")
            continue
        if line.startswith("commit"):
            write_committed(candidate)
            committed = list(candidate)
            sys.stdout.write("commit complete\n")
            if "and-quit" in line:
                mode = "op"
            continue
        sys.stdout.write("\nunknown command.\n")


def main() -> None:
    # login-shell exec form: `jcli -c "show version"`  → run once and exit.
    # The monitor's SSH collector probes with Linux commands first (hostname,
    # cat /proc/uptime, …); for anything this CLI doesn't recognise we print
    # NOTHING (not "unknown command."), so the collector falls through to its
    # Junos-aware probes (`show configuration … | display set`, `show system
    # uptime`) and gets real answers.
    if len(sys.argv) >= 3 and sys.argv[1] == "-c":
        cmd = sys.argv[2].strip()
        out = run_operational(cmd, read_committed())
        if out.strip() and out.strip() != "unknown command.":
            sys.stdout.write(out.strip("\n") + "\n")
        return
    repl()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # never crash the login shell
        sys.stderr.write(f"cli error: {exc}\n")
