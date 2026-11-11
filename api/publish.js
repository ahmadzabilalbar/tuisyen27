// POST /api/publish — admin menerbitkan data rasmi (settings.js) terus ke GitHub.
// Vercel kemudian deploy semula secara automatik, dan orang awam nampak data baharu.
//
// Environment Variables (Vercel → Project → Settings → Environment Variables):
//   ADMIN_PASSWORD  kata laluan admin (wajib)
//   GITHUB_TOKEN    fine-grained token: repo tuisyen27 sahaja, "Contents: Read and write" (wajib)
//   GITHUB_REPO     pilihan, lalai "ahmadzabilalbar/tuisyen27"
//   GITHUB_BRANCH   pilihan, lalai "main"

const crypto = require("crypto");

const FILE = "settings.js";
const FREQS = ["week", "alt", "month"];
const MODES = ["class", "hour"];

function sameSecret(a, b) {
  const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

const isNum = (v, min, max) => typeof v === "number" && isFinite(v) && v >= min && v <= max;
const numOrNull = (v, min, max) => v === null || isNum(v, min, max);
const subjKey = (k) => typeof k === "string" && k.length > 0 && k.length <= 60;

// Terima hanya bentuk data yang dijana oleh laman; buang medan lain.
function clean(input) {
  if (!input || typeof input !== "object") throw new Error("Data tidak sah");
  const sIn = input.schedule, cIn = input.cost;
  if (!sIn || typeof sIn !== "object" || !cIn || typeof cIn !== "object") throw new Error("Data tidak lengkap");

  const keys = Object.keys(sIn);
  if (!keys.length || keys.length > 20) throw new Error("Bilangan subjek tidak sah");
  const schedule = {};
  for (const k of keys) {
    const w = sIn[k];
    if (!subjKey(k) || !w || typeof w !== "object") throw new Error("Subjek tidak sah: " + k);
    if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6) throw new Error("Hari tidak sah: " + k);
    if (typeof w.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.time)) throw new Error("Masa tidak sah: " + k);
    if (!FREQS.includes(w.freq)) throw new Error("Kekerapan tidak sah: " + k);
    if (w.off !== 0 && w.off !== 1) throw new Error("Minggu A/B tidak sah: " + k);
    if (!numOrNull(w.hrs, 0, 24)) throw new Error("Jam tidak sah: " + k);
    const teacher = typeof w.teacher === "string" ? w.teacher.trim().slice(0, 80) : "";
    schedule[k] = { day: w.day, time: w.time, freq: w.freq, off: w.off, hrs: w.hrs, teacher };
  }

  const map = (obj, check, what) => {
    const out = {};
    if (obj == null) return out;
    if (typeof obj !== "object") throw new Error(what + " tidak sah");
    for (const k of Object.keys(obj)) {
      if (!subjKey(k) || !check(obj[k])) throw new Error(what + " tidak sah: " + k);
      out[k] = obj[k];
    }
    return out;
  };
  const cost = {
    fees: map(cIn.fees, (v) => numOrNull(v, 0, 100000), "Yuran"),
    mode: map(cIn.mode, (v) => MODES.includes(v), "Caj"),
    rates: map(cIn.rates, (v) => numOrNull(v, 0, 100000), "Kadar"),
    students: Number.isInteger(cIn.students) && cIn.students >= 1 && cIn.students <= 1000 ? cIn.students : 25,
    extra: isNum(cIn.extra, 0, 1000000) ? cIn.extra : 0,
  };
  return { schedule, cost };
}

async function gh(path, opts = {}) {
  const repo = process.env.GITHUB_REPO || "ahmadzabilalbar/tuisyen27";
  const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tuisyen27-admin",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error("GitHub " + r.status + ": " + (j.message || "ralat"));
    e.status = r.status;
    throw e;
  }
  return j;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Guna POST" });

  const { ADMIN_PASSWORD, GITHUB_TOKEN } = process.env;
  if (!ADMIN_PASSWORD || !GITHUB_TOKEN)
    return res.status(500).json({ ok: false, error: "Pelayan belum disediakan (ADMIN_PASSWORD / GITHUB_TOKEN tiada)" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") return res.status(400).json({ ok: false, error: "Permintaan tidak sah" });

  if (!sameSecret(body.password || "", ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 1000)); // perlahankan cubaan meneka
    return res.status(401).json({ ok: false, error: "Kata laluan salah" });
  }

  let data;
  try { data = clean(body.settings); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }

  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }).slice(0, 16);
  const header = "// Data rasmi tuisyen — diterbitkan dari mod admin (?admin) pada " + stamp + " (MYT)\n";
  const json = JSON.stringify(data, null, 2);
  const branch = process.env.GITHUB_BRANCH || "main";

  try {
    let sha, current = "";
    try {
      const f = await gh(`contents/${FILE}?ref=${encodeURIComponent(branch)}`);
      sha = f.sha;
      current = Buffer.from(f.content || "", "base64").toString("utf8");
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    // Abaikan baris komen (cap masa) bila membandingkan
    const m = current.match(/window\.TUISYEN_SETTINGS\s*=\s*([\s\S]*?);\s*$/);
    if (m && m[1].trim() === json) return res.json({ ok: true, unchanged: true });

    const out = await gh(`contents/${FILE}`, {
      method: "PUT",
      body: JSON.stringify({
        message: "Kemas kini data tuisyen dari mod admin (" + stamp + ")",
        content: Buffer.from(header + "window.TUISYEN_SETTINGS = " + json + ";\n", "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    return res.json({ ok: true, commit: out.commit && out.commit.sha, url: out.commit && out.commit.html_url });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
};
