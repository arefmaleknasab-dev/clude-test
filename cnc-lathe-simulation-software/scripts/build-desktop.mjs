#!/usr/bin/env node
/**
 * اسکریپت ساخت خودکار نسخهٔ دسکتاپ آفلاین ویندوز ۱۰ (بدون نیاز به اینترنت)
 * خروجی‌ها در پوشهٔ ../windows-desktop:
 *   - KharraatCode.exe          (فایل اجرایی ۶۴بیتی بومی ویندوز ۱۰ به همراه آیکن و اپ تعبیه‌شده)
 *   - KharraatCode-Offline.html (بستهٔ تک‌فایلی کاملاً آفلاین شامل فونت‌ها، موتور سه‌بعدی و CAM)
 *   - README-WINDOWS.txt        (راهنمای فارسی اجرا روی ویندوز ۱۰ بدون اینترنت)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..");
const outDir = path.resolve(repoRoot, "windows-desktop");
const desktopSrcDir = path.resolve(appRoot, "desktop");
const tmpBuildDir = "/tmp/kharraat-desktop-build";

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmpBuildDir, { recursive: true });

/* ---------- ۱. ساخت آیکن چنداندازه‌ای ویندوز (.ico) بدون وابستگی خارجی ---------- */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function renderIconPng(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const s = size;
  for (let y = 0; y < s; y++) {
    const rowOff = y * (1 + s * 4);
    raw[rowOff] = 0; // filter: None
    const ny = (y + 0.5) / s; // 0..1
    for (let x = 0; x < s; x++) {
      const nx = (x + 0.5) / s; // 0..1
      const px = rowOff + 1 + x * 4;

      // پس‌زمینه مربع گوشه‌گرد تیره (#1c1510) با حاشیه برنجی ملایم
      const rad = 0.21;
      const dx = Math.max(0, Math.abs(nx - 0.5) - (0.5 - rad));
      const dy = Math.max(0, Math.abs(ny - 0.5) - (0.5 - rad));
      const dCorner = Math.hypot(dx, dy);
      if (dCorner > rad + 0.5 / s) {
        raw[px] = 0; raw[px + 1] = 0; raw[px + 2] = 0; raw[px + 3] = 0;
        continue;
      }
      const edgeAa = Math.min(1, Math.max(0, (rad + 0.5 / s - dCorner) * s));
      let r = 28, g = 21, b = 16;

      // حاشیه بیرونی ظریف
      if (dCorner > rad - 1.3 / s || nx < 1.3 / s || nx > 1 - 1.3 / s || ny < 1.3 / s || ny > 1 - 1.3 / s) {
        r = 77; g = 61; b = 40;
      }

      // پروفایل قطعه خراطی متقارن حول محور افقی (ny = 0.5)
      if (nx >= 0.20 && nx <= 0.80) {
        const t = (nx - 0.20) / 0.60; // 0..1
        const profileR =
          0.19 +
          0.07 * Math.sin(t * Math.PI * 2.1) +
          0.05 * Math.cos((t - 0.25) * Math.PI * 3.2);
        const distAxis = Math.abs(ny - 0.5);
        if (distAxis <= profileR) {
          const shade = 0.72 + 0.28 * (1 - distAxis / Math.max(0.01, profileR));
          r = Math.round(227 * shade);
          g = Math.round(169 * shade);
          b = Math.round(78 * shade);
        }
      }

      // سه‌نظام سمت چپ
      if (nx >= 0.11 && nx < 0.20 && Math.abs(ny - 0.5) <= 0.27) {
        r = 154; g = 167; b = 180;
      }

      // خط‌چین محور مرکزی
      if (nx >= 0.09 && nx <= 0.91 && Math.abs(ny - 0.5) <= Math.max(0.022, 0.9 / s)) {
        if (Math.floor(nx * 14) % 2 === 0) {
          r = 243; g = 194; b = 107;
        }
      }

      // نوک الماسه فیروزه‌ای (#45b394)
      if (ny > 0.66 && ny < 0.88 && Math.abs(nx - 0.62) < (ny - 0.64) * 0.42) {
        r = 69; g = 179; b = 148;
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = Math.round(255 * edgeAa);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildIcoFile(sizes = [16, 32, 48, 256]) {
  const pngs = sizes.map((sz) => ({ sz, data: renderIconPng(sz) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICON
  header.writeUInt16LE(pngs.length, 4);

  const dirEntries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach(({ sz, data }, idx) => {
    const base = idx * 16;
    dirEntries[base + 0] = sz >= 256 ? 0 : sz;
    dirEntries[base + 1] = sz >= 256 ? 0 : sz;
    dirEntries[base + 2] = 0;
    dirEntries[base + 3] = 0;
    dirEntries.writeUInt16LE(1, base + 4);  // color planes
    dirEntries.writeUInt16LE(32, base + 6); // 32 bpp
    dirEntries.writeUInt32LE(data.length, base + 8);
    dirEntries.writeUInt32LE(offset, base + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dirEntries, ...pngs.map((p) => p.data)]);
}

const icoBuf = buildIcoFile();
const iconPath = path.resolve(desktopSrcDir, "icon.ico");
fs.writeFileSync(iconPath, icoBuf);

/* پاک‌سازی هرگونه dist قبلی پیش از بیلد تا اسکنر Tailwind فایل‌های قدیمی را نبیند */
fs.rmSync(path.resolve(appRoot, "dist"), { recursive: true, force: true });

/* ---------- ۲. اجرای Vite Build تک‌فایلی کاملاً آفلاین ---------- */
console.log("[desktop] Building single-file offline web bundle...");
execFileSync("npx", ["vite", "build"], { cwd: appRoot, stdio: "inherit" });

const distHtmlPath = path.resolve(appRoot, "dist/index.html");
let html = fs.readFileSync(distHtmlPath, "utf8");

/* اسکریپت سبک مدیریت چرخهٔ حیات پنجره دسکتاپ (فقط روی 127.0.0.1 فعال می‌شود) */
const desktopBridgeSnippet = `<script>(function(){if(location.hostname!=="127.0.0.1")return;var p=Number(location.port);if(!(p>=45820&&p<45840))return;fetch("/__open",{method:"POST",cache:"no-store"}).catch(function(){});setInterval(function(){fetch("/__ping",{method:"POST",cache:"no-store"}).catch(function(){});},2500);window.addEventListener("pagehide",function(){try{navigator.sendBeacon("/__close","1");}catch(e){}});})();</script>`;

if (html.includes("</body>")) {
  html = html.replace("</body>", `${desktopBridgeSnippet}</body>`);
} else {
  html += desktopBridgeSnippet;
}

/* بررسی نبودِ هرگونه وابستگی اینترنتی و نبودِ قوانین CSS ناسازگار با Edge قدیمی ویندوز ۱۰ */
const externalMatches = [
  ...(html.match(/<link[^>]+href=["']https?:\/\/[^"']+/gi) || []),
  ...(html.match(/<script[^>]+src=["']https?:\/\/[^"']+/gi) || []),
  ...(html.match(/url\(["']?https?:\/\/[^"')]+/gi) || []),
];
if (externalMatches.length > 0) {
  throw new Error(`External internet URLs found in offline bundle: ${externalMatches.join(", ")}`);
}

const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
if (!styleMatch) {
  throw new Error("Missing inline <style> block in single-file HTML bundle!");
}
const cssWithoutFonts = styleMatch[1].replace(/@font-face\{[^}]*\}/g, "");
const incompatibleCssChecks = [
  ["@layer", /(?:^|[^\\])@layer\b/.test(cssWithoutFonts)],
  ["@container", /(?:^|[^\\])@container\b/.test(cssWithoutFonts)],
  ["oklch()", /oklch\(/i.test(cssWithoutFonts)],
  ["inset:", /[;{]\s*inset\s*:/.test(cssWithoutFonts)],
  ["padding-inline:", /[;{]\s*padding-inline\s*:/.test(cssWithoutFonts)],
  ["padding-block:", /[;{]\s*padding-block\s*:/.test(cssWithoutFonts)],
  ["margin-inline:", /[;{]\s*margin-inline\s*:/.test(cssWithoutFonts)],
  ["margin-block:", /[;{]\s*margin-block\s*:/.test(cssWithoutFonts)],
  ["translate:", /[;{]\s*translate\s*:/.test(cssWithoutFonts)],
  ["scale:", /[;{]\s*scale\s*:/.test(cssWithoutFonts)],
  ["rotate:", /[;{]\s*rotate\s*:/.test(cssWithoutFonts)],
].filter(([, failed]) => failed);
if (incompatibleCssChecks.length > 0) {
  throw new Error(
    `Incompatible modern CSS found for stock Windows 10 Edge: ${incompatibleCssChecks.map(([k]) => k).join(", ")}`
  );
}

const offlineHtmlOut = path.resolve(outDir, "KharraatCode-Offline.html");
fs.writeFileSync(offlineHtmlOut, html, "utf8");

/* پاک‌سازی پوشه موقت dist در پروژه اصلی */
fs.rmSync(path.resolve(appRoot, "dist"), { recursive: true, force: true });

/* ---------- ۳. تولید هدر C++ حاوی بستهٔ فشرده و آیکن ---------- */
function toCppByteArray(name, buf) {
  const lines = [`static const unsigned char ${name}[] = {`];
  for (let i = 0; i < buf.length; i += 24) {
    const slice = buf.subarray(i, Math.min(i + 24, buf.length));
    lines.push("  " + Array.from(slice, (b) => `0x${b.toString(16).padStart(2, "0")}`).join(",") + ",");
  }
  lines.push(`};`);
  lines.push(`static const size_t ${name}_LEN = ${buf.length}ULL;`);
  return lines.join("\n");
}

const gzHtml = zlib.gzipSync(Buffer.from(html, "utf8"), { level: 9 });
const headerContent = [
  "#pragma once",
  "#include <cstddef>",
  toCppByteArray("EMBEDDED_APP_GZ", gzHtml),
  toCppByteArray("EMBEDDED_ICON_ICO", icoBuf),
  "",
].join("\n");

fs.writeFileSync(path.resolve(tmpBuildDir, "embedded_app.h"), headerContent, "utf8");

/* ---------- ۴. کامپایل فایل اجرایی ۶۴بیتی ویندوز ۱۰ (KharraatCode.exe) ---------- */
function ensureZigBinary() {
  const candidates = [
    "/tmp/zig-tools/ziglang/zig",
    process.env.ZIG_BIN,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.log("[desktop] Bootstrapping ziglang cross-compiler into /tmp/zig-tools...");
  execFileSync("python3", ["-m", "pip", "install", "--target", "/tmp/zig-tools", "--no-deps", "ziglang"], {
    stdio: "inherit",
  });
  return "/tmp/zig-tools/ziglang/zig";
}

const zigBin = ensureZigBinary();
const resObjPath = path.resolve(tmpBuildDir, "app.res");
const exeOutPath = path.resolve(outDir, "KharraatCode.exe");

console.log("[desktop] Compiling Windows resource (.rc -> .res)...");
execFileSync(
  zigBin,
  ["rc", `/fo${resObjPath}`, "--", path.resolve(desktopSrcDir, "app.rc")],
  { cwd: desktopSrcDir, stdio: "inherit" }
);

console.log("[desktop] Cross-compiling native Windows 10 x64 executable (KharraatCode.exe)...");
execFileSync(
  zigBin,
  [
    "c++",
    "-target", "x86_64-windows-gnu",
    "-std=c++17",
    "-Os",
    "-s",
    "-static",
    `-I${tmpBuildDir}`,
    path.resolve(desktopSrcDir, "launcher.cpp"),
    resObjPath,
    "-Wl,--subsystem,windows",
    "-lws2_32",
    "-luser32",
    "-lshell32",
    "-ladvapi32",
    "-o", exeOutPath,
  ],
  { cwd: desktopSrcDir, stdio: "inherit" }
);

/* صفر کردن TimeDateStamp هدر PE برای تکرارپذیری باینری در Git */
const peData = fs.readFileSync(exeOutPath);
if (peData.length >= 0x40 && peData.toString("ascii", 0, 2) === "MZ") {
  const peOff = peData.readUInt32LE(0x3c);
  if (peOff + 12 <= peData.length && peData.toString("ascii", peOff, peOff + 4) === "PE\0\0") {
    peData.writeUInt32LE(0, peOff + 8);
    fs.writeFileSync(exeOutPath, peData);
  }
}

/* ---------- ۵. راهنمای فارسی اجرا در ویندوز ۱۰ ---------- */
const readmeFa = [
  "======================================================================",
  "  خراط‌کد (KharraatCode) — نسخه دسکتاپ آفلاین ویژه ویندوز ۱۰ و ۱۱ (۶۴ بیتی)",
  "======================================================================",
  "",
  "ویژگی‌ها:",
  "  • کارکرد ۱۰۰٪ آفلاین (بدون نیاز به اینترنت، فونت آنلاین یا نصب Node/Python)",
  "  • شامل تمام فونت‌های فارسی (وزیرمتن و لاله‌زار)، موتور سه‌بعدی WebGL2 و شبیه‌ساز",
  "  • ذخیرهٔ پایدار پروژه‌های اخیر، تنظیمات و چیدمان پنجره‌ها در حافظه محلی ویندوز",
  "  • پشتیبانی کامل از ذخیره/بازکردن فایل پروژه (.kharraat) و خروجی CNC (.cnc) و DXF",
  "",
  "روش اجرا در ویندوز ۱۰:",
  "  ۱) کافی است فایل «KharraatCode.exe» را دابل‌کلیک کنید تا برنامه در پنجرهٔ",
  "     مستقل دسکتاپ باز شود.",
  "     (نکته: حتی اگر فایل KharraatCode.exe را به‌تنهایی روی دسکتاپ کپی کنید نیز",
  "     اجرا می‌شود؛ همچنین در صورت حضور فایل KharraatCode-Offline.html در کنار آن،",
  "     به‌طور خودکار از آخرین نسخهٔ همان پوشه بارگذاری می‌کند.)",
  "",
  "  ۲) در صورت نمایش هشدار SmartScreen ویندوز در اولین اجرا:",
  "     روی «More info» کلیک کرده و دکمهٔ «Run anyway» را بزنید.",
  "",
  "  ۳) فایل «KharraatCode-Offline.html» نیز نسخهٔ تک‌فایلی قابل‌حمل است که در صورت",
  "     نیاز می‌توانید مستقیماً با مرورگر دلخواه (Edge / Chrome / Firefox) بدون",
  "     اینترنت باز کنید.",
  "",
].join("\r\n");

fs.writeFileSync(path.resolve(outDir, "README-WINDOWS.txt"), readmeFa, "utf8");

const exeSizeKB = (fs.statSync(exeOutPath).size / 1024).toFixed(1);
const htmlSizeKB = (fs.statSync(offlineHtmlOut).size / 1024).toFixed(1);
console.log(`[desktop] Done! KharraatCode.exe (${exeSizeKB} KB), KharraatCode-Offline.html (${htmlSizeKB} KB)`);
