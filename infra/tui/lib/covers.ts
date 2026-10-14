/**
 * Book covers for the SETTINGS shelf, as braille runs (the chips.json shape).
 *
 *   committed  <books>/covers/<name>.json — written at build time by
 *              scripts/book-covers.py (generated from the name)
 *   generated  a book published at runtime (the ops catalog) has no committed
 *              cover, so it gets the generated one, drawn here with the SAME
 *              algorithm as the script; tests/test_tui.py checks the two agree.
 *
 * The algorithm (scripts/book-covers.py has the long form): seed =
 * sha256(name); byte(a, b) = sha256(seed || a || b)[0] with a, b as 2-byte
 * big-endian; a dot lights when byte(x/2, y/2) < a threshold that fades from
 * 0.62 to 0.10 down the dot rows, accent when byte(x, y) % 7 == 0 else
 * brand; a muted band (0.9 density, 0.55 under the letters) behind
 * the initials in block capitals (▀ ▄ █, accentBright) — the 3x5 glyphs, two
 * bit-rows per cell row; two letters on the cover, one on the spine.
 *
 * No solid-js here: bun tests run it on the host.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Run } from "./palette.ts";

export type Art = { cols: number; rows: number; lines: Run[][] };
export type Covers = { book: string; source: "generated"; seed: string; spine: Art; cover: Art };

const SIZES = { spine: [14, 6], cover: [28, 14] } as const;
const TOP = 0.62;
const BOTTOM = 0.1;
const BAND_DENSITY = 0.9;
const BAND_THIN = 0.55; // the band under the letters, so they read
// Unicode braille dot order: (dx, dy, bit) — scripts/brand-sync.py DOTS
const DOTS: [number, number, number][] = [[0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [1, 0, 0x08],
                                          [1, 1, 0x10], [1, 2, 0x20], [0, 3, 0x40], [1, 3, 0x80]];

const brand = (name: string) => new URL(`../brand/${name}`, import.meta.url);
const read = <T>(u: URL | string): T | undefined => {
  try {
    return JSON.parse(readFileSync(u, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const GLYPHS = read<{ glyphs: Record<string, string[]> }>(brand("font3x5.json"))?.glyphs ?? {};
const TOKENS = read<{ colors: Record<string, string> }>(brand("tokens.json"))?.colors ?? {};

export function initials(name: string): string {
  return name.replace(/_/g, "-").split("-").filter(Boolean)
    .map((p) => p[0]!.toUpperCase()).filter((c) => c in GLYPHS).join("").slice(0, 3);
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h: string) => {
  const [r, g, b] = rgb(h) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Two initials on the cover (28 cols), one on the spine (14). */
export const lettersFor = (cols: number) => (cols >= 28 ? 2 : 1);

export function generated(name: string, cols: number, rows: number,
                          colors: Record<string, string> = TOKENS, letters?: number): Run[][] {
  const seed = createHash("sha256").update(name, "utf8").digest();
  const byte = (a: number, b: number) => {
    const buf = Buffer.alloc(seed.length + 4);
    seed.copy(buf);
    buf.writeUInt16BE(a, seed.length);
    buf.writeUInt16BE(b, seed.length + 2);
    return createHash("sha256").update(buf).digest()[0]!;
  };
  const h = rows * 4;
  const text = initials(name).slice(0, letters ?? lettersFor(cols));
  // the letters: 3 cells wide x 3 rows tall each, 1 cell apart, centred
  const gy0 = Math.floor(rows / 2) - 1;
  const glyphW = text ? 4 * text.length - 1 : 0;
  const gx0 = Math.floor((cols - glyphW) / 2);
  // the band hugs the letters, two dots above and below; thinned under them
  const by0 = gy0 * 4 - 2;
  const by1 = (gy0 + 3) * 4 + 2;
  const lx0 = gx0 * 2;
  const lx1 = (gx0 + glyphW) * 2;

  const dot = (x: number, y: number): string | undefined => {
    if (y >= by0 && y < by1) {
      const density = x >= lx0 && x < lx1 ? BAND_THIN : BAND_DENSITY;
      return byte(x, y) < density * 256 ? "muted" : undefined;
    }
    const threshold = TOP - (TOP - BOTTOM) * y / (h - 1);
    if (byte(Math.floor(x / 2), Math.floor(y / 2)) >= threshold * 256) return undefined;
    return byte(x, y) % 7 === 0 ? "accent" : "brand";
  };

  const L: Record<string, number> = {};
  for (const k of ["accent", "brand", "muted"]) L[k] = lum(colors[k] ?? "#808080");
  const grid: [string | null, string][][] = [];
  for (let cy = 0; cy < rows; cy++) {
    const line: [string | null, string][] = [];
    for (let cx = 0; cx < cols; cx++) {
      let code = 0;
      const votes = new Map<string, number>();
      for (const [dx, dy, bit] of DOTS) {
        const role = dot(cx * 2 + dx, cy * 4 + dy);
        if (role) {
          code |= bit;
          votes.set(role, (votes.get(role) ?? 0) + 1);
        }
      }
      if (!code) {
        line.push([null, " "]);
        continue;
      }
      let best = "";
      for (const [role, n] of votes) {
        const bn = votes.get(best) ?? -1;
        if (n > bn || (n === bn && L[role]! > L[best]!)) best = role;
      }
      line.push([colors[best] ?? null, String.fromCharCode(0x2800 + code)]);
    }
    grid.push(line);
  }

  // block capitals OVER the texture: two glyph bit-rows per cell row (bit row
  // 5 is 000); a cell never mixes braille and blocks; the counter clears it
  [...text].forEach((ch, i) => {
    const bits = [...GLYPHS[ch]!, "..."];
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 3; k++) {
        const t = bits[2 * r]![k] === "#";
        const b = bits[2 * r + 1]![k] === "#";
        const block = t && b ? "█" : t ? "▀" : b ? "▄" : " ";
        grid[gy0 + r]![gx0 + 4 * i + k] = [block === " " ? null : colors["accentBright"] ?? null, block];
      }
    }
  });

  return grid.map((line) => {
    const runs: Run[] = [];
    for (const [colour, ch] of line) {
      const last = runs[runs.length - 1];
      if (last && last[0] === colour) last[1] += ch;
      else runs.push([colour, ch]);
    }
    return runs;
  });
}

export function generatedCovers(name: string): Covers {
  return {
    book: name, source: "generated",
    seed: createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12),
    spine: { cols: SIZES.spine[0], rows: SIZES.spine[1], lines: generated(name, ...SIZES.spine) },
    cover: { cols: SIZES.cover[0], rows: SIZES.cover[1], lines: generated(name, ...SIZES.cover) },
  };
}

const cache = new Map<string, Covers>();

/** The committed covers of a book file, else the generated ones (cached per path). */
export function coversFor(bookPath: string): Covers {
  const hit = cache.get(bookPath);
  if (hit) return hit;
  const name = basename(bookPath).replace(/\.md$/, "");
  const file = join(dirname(bookPath), "covers", `${name}.json`);
  const committed = existsSync(file) ? read<Covers>(file) : undefined;
  const c = committed?.spine?.lines && committed?.cover?.lines ? committed : generatedCovers(name);
  cache.set(bookPath, c);
  return c;
}
