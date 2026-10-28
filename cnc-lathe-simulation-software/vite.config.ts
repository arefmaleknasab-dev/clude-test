import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { transform as lightningTransform } from "lightningcss";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** جدا کردن آرگومان‌های سطح اول با فاصله (با حفظ پرانتزهای تودرتو مثل var(...) و calc(...)) */
function splitTopLevelCssSpace(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (depth === 0 && /\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** یافتن اندیس آکولاد بستهٔ متناظر با آکولاد باز در اندیس openIdx */
function findMatchingBrace(css: string, openIdx: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = openIdx; i < css.length; i++) {
    const ch = css[i];
    if (ch === "\\" && (inSingle || inDouble)) {
      i++;
      continue;
    }
    if (!inSingle && !inDouble && ch === "/" && css[i + 1] === "*") {
      const endComment = css.indexOf("*/", i + 2);
      if (endComment === -1) return css.length - 1;
      i = endComment + 1;
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return css.length - 1;
}

/** باز کردن تمام بلوک‌ها و اعلان‌های @layer با حفظ دقیق ترتیب آبشاری قوانین */
function unwrapCascadeLayers(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === "@" && css.startsWith("@layer", i) && /[\s{;]/.test(css[i + 6] || "")) {
      let j = i + 6;
      while (j < css.length && css[j] !== "{" && css[j] !== ";") j++;
      if (css[j] === ";") {
        i = j + 1;
        continue;
      }
      if (css[j] === "{") {
        const closeIdx = findMatchingBrace(css, j);
        const inner = css.slice(j + 1, closeIdx);
        out += unwrapCascadeLayers(inner);
        i = closeIdx + 1;
        continue;
      }
    }
    out += css[i];
    i++;
  }
  return out;
}

/**
 * تبدیل استایل‌های مدرن Tailwind v4 به CSS سازگار با مرورگر پیش‌فرض ویندوز ۱۰ آفلاین
 * (Microsoft Edge مبتنی بر Chromium 79+ که از @layer، oklch، @container، inset و translate/scale/rotate مستقل پشتیبانی نمی‌کند).
 */
function downgradeCssForWin10Edge(rawCss: string): string {
  // ۱. جدا کردن بلوک‌های @font-face (شامل فونت‌های WOFF2 به‌صورت base64) برای حفظ دست‌نخورده و پردازش سریع
  const fontFaces: string[] = [];
  let css = "";
  let cursor = 0;
  while (cursor < rawCss.length) {
    const idx = rawCss.indexOf("@font-face", cursor);
    if (idx === -1) {
      css += rawCss.slice(cursor);
      break;
    }
    css += rawCss.slice(cursor, idx);
    const openBrace = rawCss.indexOf("{", idx);
    if (openBrace === -1) {
      css += rawCss.slice(idx);
      break;
    }
    const closeBrace = findMatchingBrace(rawCss, openBrace);
    fontFaces.push(rawCss.slice(idx, closeBrace + 1));
    cursor = closeBrace + 1;
  }

  // ۲. باز کردن تمام @layer ها با حفظ ترتیب properties -> theme -> base -> components -> utilities
  css = unwrapCascadeLayers(css);

  // ۳. فعال‌سازی بدون‌شرط متغیرهای اولیه --tw-* و بازنویسی color-mix متغیرهای تم برای Chromium 79+
  const RGB_THEME_TOKENS = new Set([
    "bg", "panel", "panel2", "panel3", "edge", "edge2",
    "ink", "mute", "dim", "brass", "brass2", "copper",
    "teal", "steel", "ok", "danger",
  ]);
  css = css.replace(
    /color-mix\(\s*in\s+[a-z-]+\s*,\s*var\(--color-([a-z0-9-]+)\)\s*([0-9.]+)%\s*,\s*transparent\s*\)/gi,
    (full, token: string, pctStr: string) => {
      const key = token.toLowerCase();
      if (!RGB_THEME_TOKENS.has(key)) return full;
      const alpha = Math.max(0, Math.min(1, Number(pctStr) / 100));
      return `rgba(var(--rgb-${key}), ${Number(alpha.toFixed(4))})`;
    }
  );

  let supIdx = 0;
  while ((supIdx = css.indexOf("@supports", supIdx)) !== -1) {
    const openBrace = css.indexOf("{", supIdx);
    if (openBrace === -1) break;
    const header = css.slice(supIdx, openBrace);
    if (
      (header.includes("-webkit-hyphens") && header.includes("margin-trim")) ||
      (header.includes("color-mix") && !css.slice(openBrace + 1, findMatchingBrace(css, openBrace)).includes("color-mix("))
    ) {
      const closeBrace = findMatchingBrace(css, openBrace);
      const inner = css.slice(openBrace + 1, closeBrace);
      css = css.slice(0, supIdx) + inner + css.slice(closeBrace + 1);
    } else {
      supIdx = openBrace + 1;
    }
  }

  // ۴. ترنسپایل رنگ‌های oklch/oklab و افزودن پیشوندهای لازم برای Chrome/Edge 79
  const targets = { chrome: 79 << 16, edge: 79 << 16 };
  css = lightningTransform({
    filename: "app.css",
    code: Buffer.from(css),
    minify: true,
    targets,
  }).code.toString();

  // ۵. تبدیل ویژگی‌های منطقی و تبدیل‌های مستقل که به‌خاطر وجود var(...) توسط lightningcss بازنویسی نشده‌اند
  css = css
    .replace(/([;{])\s*inset\s*:\s*([^;{}!]+?)(\s*!important)?(?=\s*[;}])/g, (_m, pre, val, imp = "") => {
      const v = val.trim();
      return `${pre}top:${v}${imp};right:${v}${imp};bottom:${v}${imp};left:${v}${imp}`;
    })
    .replace(/([;{])\s*padding-inline\s*:\s*([^;{}!]+?)(\s*!important)?(?=\s*[;}])/g, (_m, pre, val, imp = "") => {
      const v = val.trim();
      return `${pre}padding-left:${v}${imp};padding-right:${v}${imp}`;
    })
    .replace(/([;{])\s*padding-block\s*:\s*([^;{}!]+?)(\s*!important)?(?=\s*[;}])/g, (_m, pre, val, imp = "") => {
      const v = val.trim();
      return `${pre}padding-top:${v}${imp};padding-bottom:${v}${imp}`;
    })
    .replace(/([;{])\s*margin-inline\s*:\s*([^;{}!]+?)(\s*!important)?(?=\s*[;}])/g, (_m, pre, val, imp = "") => {
      const v = val.trim();
      return `${pre}margin-left:${v}${imp};margin-right:${v}${imp}`;
    })
    .replace(/([;{])\s*margin-block\s*:\s*([^;{}!]+?)(\s*!important)?(?=\s*[;}])/g, (_m, pre, val, imp = "") => {
      const v = val.trim();
      return `${pre}margin-top:${v}${imp};margin-bottom:${v}${imp}`;
    })
    .replace(/([;{])\s*translate\s*:\s*([^;{}!]+?)(\s*!important)?(?=\s*[;}])/g, (_m, pre, val, imp = "") => {
      const args = splitTopLevelCssSpace(val.trim());
      const fn =
        args.length >= 3
          ? `translate3d(${args[0]},${args[1]},${args[2]})`
          : args.length === 2
            ? `translate(${args[0]},${args[1]})`
            : `translate(${args[0]})`;
      return `${pre}transform:${fn}${imp}`;
    })
    .replace(/([;{])\s*scale\s*:\s*([^;{}!]+?)(\s*!important)?(?=\s*[;}])/g, (_m, pre, val, imp = "") => {
      const args = splitTopLevelCssSpace(val.trim());
      const fn = args.length >= 2 ? `scale(${args[0]},${args[1]})` : `scale(${args[0]})`;
      return `${pre}transform:${fn}${imp}`;
    })
    .replace(/([;{])\s*rotate\s*:\s*([^;{}!]+?)(\s*!important)?(?=\s*[;}])/g, (_m, pre, val, imp = "") => {
      return `${pre}transform:rotate(${val.trim()})${imp}`;
    })
    .replace(/3\.40282e38px/gi, "9999px");

  // ۶. اعتبارسنجی مجدد AST و فشرده‌سازی نهایی با lightningcss
  css = lightningTransform({
    filename: "app-compat.css",
    code: Buffer.from(css),
    minify: true,
    targets,
  }).code.toString();

  return fontFaces.join("") + css;
}

function win10EdgeCssCompatPlugin(): Plugin {
  return {
    name: "win10-edge-css-compat",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== "asset") continue;
        if (item.fileName.endsWith(".css")) {
          const src = typeof item.source === "string" ? item.source : Buffer.from(item.source).toString("utf8");
          item.source = downgradeCssForWin10Edge(src);
        } else if (item.fileName.endsWith(".html")) {
          const src = typeof item.source === "string" ? item.source : Buffer.from(item.source).toString("utf8");
          item.source = src.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_full, cssBody: string) => {
            return `<style>${downgradeCssForWin10Edge(cssBody)}</style>`;
          });
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), win10EdgeCssCompatPlugin()],
  build: {
    target: "chrome79",
    cssTarget: "chrome79",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
  },
});
