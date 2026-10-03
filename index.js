import fs from "node:fs";
import * as cheerio from "cheerio";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK) {
  console.error("DISCORD_WEBHOOK_URL is not set");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const SEEN_FILE = "seen.json";
const MAX_PER_RUN = 20;

const seen = new Set(
  fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) : []
);

// ---------- keyword matching (whole words, case-insensitive) ----------
const toRegex = (list) =>
  new RegExp(
    "\\b(" + list.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
    "i"
  );
const includeRe = toRegex(config.include);
const excludeRe = config.exclude.length ? toRegex(config.exclude) : null;

const isMatch = (title) =>
  includeRe.test(title) && !(excludeRe && excludeRe.test(title));

// ---------- fetch helper ----------
async function get(url, asJson = false) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (job-watcher)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return asJson ? res.json() : res.text();
}

const clean = (s) => s.replace(/\s+/g, " ").trim();

// ---------- source types ----------
const fetchers = {
  // https://boards.greenhouse.io/<token>
  async greenhouse(src) {
    const data = await get(
      `https://boards-api.greenhouse.io/v1/boards/${src.token}/jobs`,
      true
    );
    return data.jobs.map((j) => ({
      title: j.title,
      url: j.absolute_url,
      location: j.location?.name || "",
    }));
  },

  // https://jobs.lever.co/<slug>
  async lever(src) {
    const data = await get(`https://api.lever.co/v0/postings/${src.slug}?mode=json`, true);
    return data.map((j) => ({
      title: j.text,
      url: j.hostedUrl,
      location: j.categories?.location || "",
    }));
  },

  // Any normal career page / job board: reads links on the page.
  // Optional "selector" limits which links are checked.
  async html(src) {
    const $ = cheerio.load(await get(src.url));
    const jobs = [];
    $(src.selector || "a").each((_, el) => {
      const title = clean($(el).text());
      const href = $(el).attr("href");
      if (!href || title.length < 4 || title.length > 140) return;
      try {
        jobs.push({ title, url: new URL(href, src.url).href, location: "" });
      } catch {}
    });
    return jobs;
  },
};

// ---------- companies.json: all career page links ----------
// Each entry is either a URL string, or { "name": "...", "url": "..." }
function parseEntry(entry) {
  const url = typeof entry === "string" ? entry.trim() : (entry.url || "").trim();
  let u;
  try {
    u = new URL(url);
  } catch {
    console.warn(`companies.json: skipping invalid entry: ${JSON.stringify(entry)}`);
    return null;
  }
  const name =
    (typeof entry === "object" && entry.name) || u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (/greenhouse\.io$/.test(u.hostname) && parts[0]) {
    return { name, type: "greenhouse", token: parts[0] };
  }
  if (u.hostname === "jobs.lever.co" && parts[0]) {
    return { name, type: "lever", slug: parts[0] };
  }
  return { name, type: "html", url };
}

const allSources = JSON.parse(fs.readFileSync("companies.json", "utf8"))
  .map(parseEntry)
  .filter(Boolean);

// ---------- main ----------
const found = [];
const failed = [];

for (const src of allSources) {
  try {
    const jobs = await fetchers[src.type](src);
    const hits = jobs.filter((j) => isMatch(j.title));
    console.log(`${src.name}: ${jobs.length} links/jobs, ${hits.length} match`);
    for (const j of hits) {
      if (!seen.has(j.url)) found.push({ ...j, company: src.name });
    }
  } catch (err) {
    console.error(`${src.name}: FAILED (${err.message})`);
    failed.push(src.name);
  }
}

// de-duplicate within this run
const unique = [...new Map(found.map((j) => [j.url, j])).values()].slice(0, MAX_PER_RUN);

async function sendToDiscord(jobs) {
  for (let i = 0; i < jobs.length; i += 10) {
    const embeds = jobs.slice(i, i + 10).map((j) => ({
      title: j.title.slice(0, 256),
      url: j.url,
      description: [j.company, j.location].filter(Boolean).join(" • "),
      color: 0x2ecc71,
    }));
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "🔔 New matching job(s):", embeds }),
    });
    if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (unique.length) {
  await sendToDiscord(unique);
  unique.forEach((j) => seen.add(j.url)); // only mark as seen after a successful send
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 2));
  console.log(`Sent ${unique.length} notification(s)`);
} else {
  console.log("No new matching jobs");
}

if (failed.length) console.warn("Sources that failed:", failed.join(", "));
