import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { devAppOrigins } from "./dev/dev-origins.js";

function address(value: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  return { address: value, family, internal, netmask: "", mac: "00:00:00:00:00:00", cidr: null } as NetworkInterfaceInfo;
}

describe("本機 dev server 的前端 origin 白名單", () => {
  it("沒有網卡時只有 localhost 與 127.0.0.1，順序照 port", () => {
    expect(devAppOrigins({}, [5173, 5176])).toEqual([
      "http://localhost:5173", "http://127.0.0.1:5173",
      "http://localhost:5176", "http://127.0.0.1:5176",
    ]);
  });

  it("加上每張網卡的區網 IPv4，讓手機從區網打開也能送出", () => {
    const origins = devAppOrigins({
      "Wi-Fi": [address("192.168.0.27", "IPv4"), address("fe80::1", "IPv6")],
      "vEthernet (WSL)": [address("172.19.48.1", "IPv4")],
    }, [5173, "5176"]);
    expect(origins).toContain("http://192.168.0.27:5173");
    expect(origins).toContain("http://192.168.0.27:5176");
    expect(origins).toContain("http://172.19.48.1:5176");
  });

  it("不放 loopback、IPv6，也不重複", () => {
    const origins = devAppOrigins({
      Loopback: [address("127.0.0.1", "IPv4", true), address("::1", "IPv6", true)],
      "Wi-Fi": [address("192.168.0.27", "IPv4"), address("fe80::1", "IPv6")],
      Bridge: [address("192.168.0.27", "IPv4")],
    }, [5176]);
    expect(origins).toEqual(["http://localhost:5176", "http://127.0.0.1:5176", "http://192.168.0.27:5176"]);
  });
});
