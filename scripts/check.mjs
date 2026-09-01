#!/usr/bin/env node
/* ============================================================
   check.mjs — 4ページのシナリオ定義の回帰チェック
   使い方: node scripts/check.mjs   （push前に実行する）

   各HTMLの先頭のデータ<script>（THREE非依存）を抽出・評価し、
   全シナリオを200点サンプリングして次を検証する:
     ・セグメントのdurが正の有限値
     ・位置(x,y,z)にNaN/無限が出ない
     ・高度が負にならない／異常に大きくない
   airplane/renewal はページ内のsamplePoseを使用し、
   multirotor/helicopter は同等の汎用サンプラで代替する。
============================================================ */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["multirotor.html", "helicopter.html", "airplane.html", "renewal.html"];

const ease = (u) => u * u * (3 - 2 * u);
// multirotor/helicopter 用の汎用サンプラ（renewal統合版と同等）
function genericSample(segs, time) {
  let acc = 0;
  for (const s of segs) {
    if (time <= acc + s.dur || s === segs[segs.length - 1]) {
      const u = Math.min(1, Math.max(0, (time - acc) / s.dur));
      let x = 0, y = 0, z = 0;
      if (s.t === "wait") { x = s.p[0]; z = s.p[1]; y = 0; }
      else if (s.t === "roll") { const e = u; x = s.a[0] + (s.b[0] - s.a[0]) * e; z = s.a[1] + (s.b[1] - s.a[1]) * e; y = 0; }
      else if (s.t === "line") { x = s.a[0] + (s.b[0] - s.a[0]) * u; z = s.a[1] + (s.b[1] - s.a[1]) * u; y = s.a[2] + (s.b[2] - s.a[2]) * u; }
      else if (s.t === "takeoff") { x = s.p[0]; z = s.p[1]; y = ease(u) * s.h; }
      else if (s.t === "land") { x = s.p[0]; z = s.p[1]; y = (1 - ease(u)) * s.h; }
      else if (s.t === "hover" || s.t === "rotate") { x = s.p[0]; z = s.p[1]; y = s.h; }
      else if (s.t === "move") { const e = ease(u); x = s.a[0] + (s.b[0] - s.a[0]) * e; z = s.a[1] + (s.b[1] - s.a[1]) * e; y = s.a[2] + (s.b[2] - s.a[2]) * e; }
      else if (s.t === "arc") { const a = s.a0 + (s.a1 - s.a0) * u; x = s.c[0] + s.r * Math.cos(a); z = s.c[1] + s.r * Math.sin(a); y = (s.h0 !== undefined) ? s.h0 + (s.h1 - s.h0) * u : s.h; }
      else if (s.t === "spiral") { const a = s.a0 + (s.a1 - s.a0) * u; const r = s.r0 + (s.r1 - s.r0) * ease(u); x = s.c[0] + r * Math.cos(a); z = s.c[1] + r * Math.sin(a); y = s.h0 + (s.h1 - s.h0) * ease(u); }
      else throw new Error("unknown segment type: " + s.t);
      return { x, y, z };
    }
    acc += s.dur;
  }
}

function extractDataScript(html, file) {
  // src属性のない最初の<script>（データ定義ブロック）を取り出す
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].includes("SCENARIOS") || m[1].includes("const SCEN")) return m[1];
  }
  throw new Error(file + ": data script not found");
}

let failures = 0;
const report = [];

for (const file of PAGES) {
  const html = readFileSync(join(root, file), "utf8");
  const code = extractDataScript(html, file);
  const ctx = new Function(
    code +
      `;return {
        SCENARIOS: typeof SCENARIOS !== "undefined" ? SCENARIOS : null,
        SCEN: typeof SCEN !== "undefined" ? SCEN : null,
        samplePose: typeof samplePose !== "undefined" ? samplePose : null,
        totalDur: typeof totalDur !== "undefined" ? totalDur : null,
      };`
  )();

  const scenarios = [];
  if (ctx.SCEN) {
    for (const ty of Object.keys(ctx.SCEN))
      for (const cl of Object.keys(ctx.SCEN[ty]))
        scenarios.push({ label: `${ty}-${cl}`, sc: ctx.SCEN[ty][cl] });
  } else if (ctx.SCENARIOS) {
    for (const cl of Object.keys(ctx.SCENARIOS))
      ctx.SCENARIOS[cl].forEach((sc, i) => scenarios.push({ label: `${cl}-${i} ${sc.name}`, sc }));
  }

  for (const { label, sc } of scenarios) {
    const errs = [];
    let total = 0;
    for (const [i, s] of (sc.segs || []).entries()) {
      if (!(Number.isFinite(s.dur) && s.dur > 0)) errs.push(`seg#${i} dur=${s.dur}`);
      total += s.dur || 0;
    }
    if (!(total > 0)) errs.push("total=0");

    let minY = Infinity, maxY = -Infinity, maxR = 0;
    for (let i = 0; i <= 200; i++) {
      const time = (total * i) / 200;
      let p;
      try {
        p = ctx.samplePose ? ctx.samplePose(sc, time) : genericSample(sc.segs, time);
      } catch (e) { errs.push(`sample@${time.toFixed(1)}s: ${e.message}`); break; }
      if (![p.x, p.y, p.z].every(Number.isFinite)) { errs.push(`NaN@${time.toFixed(1)}s`); break; }
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      maxR = Math.max(maxR, Math.hypot(p.x, p.z));
    }
    if (minY < -0.01) errs.push(`minY=${minY.toFixed(2)}`);
    if (maxY > 300) errs.push(`maxY=${maxY.toFixed(0)} (>300m?)`);
    if (maxR > 2000) errs.push(`maxR=${maxR.toFixed(0)} (>2km?)`);

    if (errs.length) {
      failures++;
      report.push(`✗ ${file} ${label}: ${errs.join(", ")}`);
    } else {
      report.push(`✓ ${file} ${label} (${Math.round(total)}s, alt ${minY.toFixed(1)}–${maxY.toFixed(1)}m)`);
    }
  }
}

console.log(report.join("\n"));
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
