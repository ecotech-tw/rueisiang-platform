import { describe, expect, it } from "vitest";
import { parseInvoiceQr, pickInvoiceFields } from "./invoice-qr.js";

describe("電子發票證明聯左側 QR code", () => {
  it("讀出發票號碼、民國日期轉西元、十六進位的含稅總計與賣方統編", () => {
    // 財政部規格說明的範例：銷售額 0x144=324、總計額 0x154=340，買方統編空白（00000000）。
    expect(parseInvoiceQr("AB112233441020523999900000144000001540000000001234567ydXZt4LAN1UHN/j1juVcRA==:**********:3:3:1:乾電池:1:105:")).toEqual({
      invoiceNumber: "AB11223344",
      spentOn: "2013-05-23",
      amountDollars: 340,
      sellerTaxId: "01234567",
    });
  });

  it("前後有空白也讀得到", () => {
    expect(parseInvoiceQr("  CD123456781151126123400000064000000692345678912345678abcdefghijklmnopqrstuvwx  ")).toMatchObject({
      invoiceNumber: "CD12345678",
      spentOn: "2026-11-26",
      amountDollars: 105,
      sellerTaxId: "12345678",
    });
  });

  it.each([
    ["右側 QR code（只有品項）", "**:乾電池:1:105:"],
    ["不是發票的 QR code", "https://example.com/coupon"],
    ["號碼格式錯", "A1122334411020523999900000144000001540000000001234567"],
    ["不存在的日期", "AB112233441150230999900000144000001540000000001234567"],
    ["總計額為零", "AB112233441020523999900000000000000000000000001234567"],
    ["太短", "AB1122334410205"],
  ])("%s回傳 null，讓使用者手填", (_label, text) => {
    expect(parseInvoiceQr(text)).toBeNull();
  });
});

describe("一張照片讀到好幾個 QR code", () => {
  it("略過右側（**）與無關的 QR code，挑出左側那個", () => {
    expect(pickInvoiceFields([
      "**:洗碗精補充包:1:30:海綿:2:15:",
      "https://example.com",
      "QR123456781151120123400000064000000690000000024681357ydXZt4LAN1UHN/j1juVcRA==:**********:2:2:1:清潔用品:1:60:",
    ])).toMatchObject({ invoiceNumber: "QR12345678", spentOn: "2026-11-20", amountDollars: 105, sellerTaxId: "24681357" });
  });

  it("只有右側或沒有可用的 QR code 時回傳 null", () => {
    expect(pickInvoiceFields(["**:洗碗精補充包:1:30:"])).toBeNull();
    expect(pickInvoiceFields([])).toBeNull();
  });
});
