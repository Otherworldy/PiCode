import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MobileRemoteFirewallState } from "@zcode/shared";
import { selectLanIPv4 } from "./mobileRemoteTransport.js";

const execFileAsync = promisify(execFile);
const FIREWALL_RULE_NAME = "ZCode Phone Remote";

export async function resolveAdvertisedLanIPv4(): Promise<string | null> {
  if (process.platform === "win32") {
    const routed = await windowsDefaultRouteIPv4();
    if (routed && routed !== "127.0.0.1") return routed;
  }
  return selectLanIPv4();
}

function windowsDefaultRouteIPv4(): Promise<string | null> {
  const script = [
    "$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |",
    "Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1;",
    "if (-not $route) { return };",
    "$address = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |",
    "Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |",
    "Select-Object -First 1 -ExpandProperty IPAddress;",
    "if ($address) { Write-Output $address }",
  ].join(" ");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const address = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line));
        resolve(address ?? null);
      },
    );
  });
}

function isListenPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** 旧规则按程序路径放行，开发时路径一对不上就等于没放行。现在只认当前监听端口。 */
async function enabledRulePort(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "netsh",
      ["advfirewall", "firewall", "show", "rule", `name=${FIREWALL_RULE_NAME}`],
      { timeout: 5000, windowsHide: true },
    );
    if (!/enabled:\s*yes|已启用:\s*是/i.test(stdout)) return null;
    const match = stdout.match(/(?:LocalPort|本地端口)\s*:\s*(\d+)/i);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function replaceWithPortRule(port: number): Promise<void> {
  await execFileAsync(
    "netsh",
    ["advfirewall", "firewall", "delete", "rule", `name=${FIREWALL_RULE_NAME}`],
    { timeout: 5000, windowsHide: true },
  ).catch(() => undefined);
  await execFileAsync(
    "netsh",
    [
      "advfirewall",
      "firewall",
      "add",
      "rule",
      `name=${FIREWALL_RULE_NAME}`,
      "dir=in",
      "action=allow",
      "protocol=TCP",
      `localport=${port}`,
      "enable=yes",
      "profile=any",
    ],
    { timeout: 5000, windowsHide: true },
  );
}

async function replaceWithPortRuleElevated(port: number): Promise<void> {
  const inner = [
    `netsh advfirewall firewall delete rule name="${FIREWALL_RULE_NAME}"`,
    `netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${port} enable=yes profile=any`,
  ].join("\n");
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const launcher = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", launcher], {
    timeout: 120000,
    windowsHide: true,
  });
}

/** 本机访问不经过入站防火墙。局域网只放行这次配对正在听的 TCP 端口，不记录地址或口令。 */
export async function ensureWindowsMobileRemoteFirewall(
  port: number,
): Promise<MobileRemoteFirewallState> {
  if (process.platform !== "win32") return "allowed";
  if (!isListenPort(port)) return "blocked";
  if ((await enabledRulePort()) === port) return "allowed";
  try {
    await replaceWithPortRule(port);
    return "allowed";
  } catch {
    try {
      await replaceWithPortRuleElevated(port);
    } catch {
      return "blocked";
    }
    return (await enabledRulePort()) === port ? "allowed" : "blocked";
  }
}
