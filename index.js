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
const REQUEST_TIMEOUT_MS = 20000;
const DETAIL_CONCURRENCY = 4;
const SOURCE_CONCURRENCY = 4;

const seen = new Set(
  fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) : []
);

// ---------- keyword matching (whole words, case-insensitive) ----------
const toRegex = (list) =>
  new RegExp(
    "\\b(" + list.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
    "i"
  );
if (!Array.isArray(config.include) || !config.include.length || !Array.isArray(config.exclude)) {
  throw new Error('config.json must contain a non-empty "include" array and an "exclude" array');
}
const includeRe = toRegex(config.include);
const excludeRe = config.exclude.length ? toRegex(config.exclude) : null;

const isMatch = (title) =>
  includeRe.test(title) && !(excludeRe && excludeRe.test(title));

// ---------- fetch helper ----------
async function get(url, asJson = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; job-watcher/1.0)",
          Accept: asJson ? "application/json" : "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      continue;
    }
    if (res.ok) return asJson ? res.json() : res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 2) throw new Error(`HTTP ${res.status}`);
    const retryAfter = Number(res.headers.get("retry-after"));
    await new Promise((resolve) => setTimeout(resolve, retryAfter > 0
      ? Math.min(retryAfter * 1000, 10000)
      : 500 * (2 ** attempt)));
  }
  throw new Error("Request failed after retries");
}

const clean = (s = "") => String(s).replace(/\s+/g, " ").trim();
const canonicalUrl = (value, base) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!/^#(?:\/|!)/.test(url.hash)) url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
}

// ---------- source types ----------
const fetchers = {
  // https://boards.greenhouse.io/<token>
  async greenhouse(src) {
    const data = await get(
      `https://boards-api.greenhouse.io/v1/boards/${src.token}/jobs`,
      true
    );
    return data.jobs.map((j) => ({
      title: j.title, url: j.absolute_url, location: j.location?.name || "", id: j.id,
    }));
  },

  // https://jobs.lever.co/<slug>
  async lever(src) {
    const data = await get(`https://api.lever.co/v0/postings/${encodeURIComponent(src.slug)}?mode=json`, true);
    return data.map((j) => ({
      title: j.text,
      url: j.hostedUrl,
      location: j.categories?.location || "",
      description: j.descriptionPlain || htmlToText(j.description || ""),
    }));
  },

  // Any normal career page / job board: reads links on the page.
  // Optional "selector" limits which links are checked.
  async html(src) {
    const $ = cheerio.load(await get(src.url));
    const jobs = extractStructuredJobs($, src.url);
    $(src.selector || "a[href]").each((_, el) => {
      const link = $(el);
      const title = clean(link.attr("aria-label") || link.text());
      const url = canonicalUrl(link.attr("href"), src.url);
      if (!url || title.length < 4 || title.length > 140 || isBoilerplateLink(title)) return;
      jobs.push({ title, url, location: "" });
    });
    return [...new Map(jobs.map((job) => [job.url, job])).values()];
  },
};

function isBoilerplateLink(title) {
  return /^(apply( now)?|learn more|read more|view (all )?(jobs?|careers?)|careers?|jobs?|home|about|contact|privacy|terms|sign in|log in)$/i.test(title);
}

function extractStructuredJobs($, baseUrl) {
  const jobs = [];
  $("script[type='application/ld+json']").each((_, el) => {
    let root;
    try { root = JSON.parse($(el).contents().text()); } catch { return; }
    const pending = Array.isArray(root) ? [...root] : [root];
    while (pending.length) {
      const item = pending.pop();
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item)) { pending.push(...item); continue; }
      if (item["@graph"]) pending.push(...(Array.isArray(item["@graph"]) ? item["@graph"] : [item["@graph"]]));
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      if (!types.includes("JobPosting")) continue;
      const rawLocation = item.jobLocation?.address || item.jobLocation;
      const address = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      const addressText = address?.address
        ? [address.address.addressLocality, address.address.addressRegion, address.address.addressCountry].filter(Boolean).join(", ")
        : "";
      const url = canonicalUrl(typeof item.url === "string" ? item.url : "", baseUrl);
      if (!item.title || !url) continue;
      jobs.push({
        title: clean(item.title), url, location: clean(addressText),
        description: htmlToText(item.description || ""),
      });
    }
  });
  return jobs;
}

function htmlToText(html) {
  return clean(cheerio.load(html).root().text());
}

async function addHtmlDescriptions(jobs) {
  return mapLimit(jobs, DETAIL_CONCURRENCY, async (job) => {
    if (job.description) return job;
    try {
      const $ = cheerio.load(await get(job.url));
      const structured = extractStructuredJobs($, job.url)
        .find((item) => item.title.toLowerCase() === job.title.toLowerCase());
      if (structured?.description) return { ...job, description: structured.description };
      $("script, style, nav, header, footer, noscript, form, svg").remove();
      const content = $("main, article, [role='main'], .job-description, .job-description-content, #job-description").first();
      const description = clean((content.length ? content : $("body")).text());
      return { ...job, description: description.slice(0, 12000) };
    } catch {
      return job;
    }
  });
}

async function addGreenhouseDescriptions(src, jobs) {
  return mapLimit(jobs, DETAIL_CONCURRENCY, async (job) => {
    try {
      const detail = await get(
        `https://boards-api.greenhouse.io/v1/boards/${src.token}/jobs/${job.id}?content=true`,
        true
      );
      return { ...job, description: htmlToText(detail.content || "") };
    } catch {
      return job;
    }
  });
}

// ---------- companies.json: all career page links ----------
// Each entry is either a URL string, or { "name": "...", "url": "..." }
function parseEntry(entry) {
  if (typeof entry !== "string" && (!entry || typeof entry !== "object")) {
    console.warn(`companies.json: skipping invalid entry: ${JSON.stringify(entry)}`);
    return null;
  }
  const url = typeof entry === "string" ? entry.trim() : String(entry.url || "").trim();
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
  return { name, type: "html", url, ...(typeof entry === "object" && entry.selector ? { selector: entry.selector } : {}) };
}

const companyEntries = JSON.parse(fs.readFileSync("companies.json", "utf8"));
if (!Array.isArray(companyEntries)) throw new Error("companies.json must be a JSON array");
const allSources = companyEntries
  .map(parseEntry)
  .filter(Boolean);

// ---------- main ----------
const results = await mapLimit(allSources, SOURCE_CONCURRENCY, async (src) => {
  try {
    const jobs = await fetchers[src.type](src);
    let hits = jobs.filter((job) => job.title && job.url && isMatch(job.title));
    if (src.type === "html") hits = await addHtmlDescriptions(hits);
    if (src.type === "greenhouse") hits = await addGreenhouseDescriptions(src, hits);
    console.log(`${src.name}: ${jobs.length} listings, ${hits.length} match`);
    return { src, hits };
  } catch (err) {
    console.error(`${src.name}: FAILED (${err.message})`);
    return { src, hits: [], failed: true };
  }
});
const found = results.flatMap(({ src, hits }) => hits
  .filter((job) => !seen.has(job.url))
  .map((job) => ({ ...job, company: src.name })));
const failed = results.filter((result) => result.failed).map(({ src }) => src.name);

// de-duplicate within this run
const unique = [...new Map(found.map((j) => [j.url, j])).values()].slice(0, MAX_PER_RUN);

async function sendToDiscord(jobs) {
  for (let i = 0; i < jobs.length; i += 10) {
    const batch = jobs.slice(i, i + 10);
    const embeds = batch.map((j) => ({
      title: j.title.slice(0, 256),
      url: j.url,
      description: [j.company, j.location, j.description || "Job description unavailable"].filter(Boolean).join(" • ").slice(0, 4096),
      color: 0x2ecc71,
    }));
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "🔔 New matching job(s):", embeds }),
    });
    if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
    batch.forEach((job) => seen.add(job.url));
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 2));
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (unique.length) {
  await sendToDiscord(unique);
  console.log(`Sent ${unique.length} notification(s)`);
} else {
  console.log("No new matching jobs");
}

if (failed.length) console.warn("Sources that failed:", failed.join(", "));
