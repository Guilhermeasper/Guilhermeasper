import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MONTHS_BACK = 6;
const AXIS_MAX_DAY = 31;
const MILLISECONDS_PER_DAY = 86_400_000;
const WIDTH = 760;
const HEIGHT = 300;
const MARGIN = { top: 72, right: 24, bottom: 42, left: 54 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const DAY_GUIDES = [1, 6, 11, 16, 21, 26, 31];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type ContributionDay = { year: number; month: number; day: number; count: number };
type ActivityPoint = { day: number; score: number };
type MonthSeries = { label: string; points: (ActivityPoint | null)[]; isCurrent: boolean };
type ThemeName = "light" | "dark";
type Theme = {
  background: string;
  gridline: string;
  axisText: string;
  title: string;
  seriesColors: readonly [string, string, string, string, string, string];
};
type FetchContributionHtml = (input: { login: string }) => Promise<unknown>;
type GeneratorOptions = {
  login: string;
  outputDir: string;
  now?: Date;
  fetchContributionHtml?: FetchContributionHtml;
};

const THEMES = {
  light: {
    background: "#ffffff",
    gridline: "#dbdbff",
    axisText: "#323144",
    title: "#06005b",
    seriesColors: ["#a21caf", "#c2410c", "#a16207", "#15803d", "#0e7490", "#06005b"],
  },
  dark: {
    background: "#0d1117",
    gridline: "#323144",
    axisText: "#e8e5fb",
    title: "#a4aafe",
    seriesColors: ["#f0abfc", "#fdba74", "#fde047", "#4ade80", "#67e8f9", "#a4aafe"],
  },
} satisfies Record<ThemeName, Theme>;

function readAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`))?.[1];
}

function parseDate(value: string): Omit<ContributionDay, "count"> {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    !match ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid contribution date: ${value}`);
  }

  return { year, month, day };
}

function parseCount(text: string, cellId: string): number {
  const countText = text.match(/^(No|\d{1,3}(?:,\d{3})+|\d+) contributions?\b/i)?.[1];
  if (!countText) throw new Error(`Malformed contribution count for ${cellId}`);

  const count = countText.toLowerCase() === "no" ? 0 : Number(countText.replaceAll(",", ""));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Malformed contribution count for ${cellId}`);
  return count;
}

export function parseContributionFeed(html: unknown): ContributionDay[] {
  if (typeof html !== "string") throw new Error("Contribution feed must be HTML text");

  const countsByCell = new Map<string, number>();
  for (const match of html.matchAll(/<tool-tip\b[^>]*>[\s\S]*?<\/tool-tip>/g)) {
    const tag = match[0];
    const cellId = readAttribute(tag, "for");
    if (!cellId) throw new Error("Contribution tooltip is missing its target");
    if (countsByCell.has(cellId)) throw new Error(`Duplicate contribution tooltip: ${cellId}`);

    const text = tag.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    countsByCell.set(cellId, parseCount(text, cellId));
  }

  const days: ContributionDay[] = [];
  const seenDates = new Set<string>();
  const matchedCells = new Set<string>();
  for (const match of html.matchAll(/<td\b[^>]*>/g)) {
    const tag = match[0];
    const dateValue = readAttribute(tag, "data-date");
    if (!dateValue) continue;

    const cellId = readAttribute(tag, "id");
    const count = cellId ? countsByCell.get(cellId) : undefined;
    if (!cellId || count === undefined) throw new Error(`Missing contribution count for ${dateValue}`);
    if (seenDates.has(dateValue)) throw new Error(`Duplicate contribution date: ${dateValue}`);

    seenDates.add(dateValue);
    matchedCells.add(cellId);
    days.push({ ...parseDate(dateValue), count });
  }

  for (const cellId of countsByCell.keys()) {
    if (!matchedCells.has(cellId)) throw new Error(`Unmatched contribution tooltip: ${cellId}`);
  }

  return days;
}

function monthStart(now: Date, offset: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

const ANSCOMBE_ZERO_OFFSET = 2 * Math.sqrt(3 / 8);

function anscombeValue(count: number): number {
  return 2 * Math.sqrt(count + 3 / 8) - ANSCOMBE_ZERO_OFFSET;
}

export function applyAnscombeTransform(countsByDay: Map<number, number>): Map<number, number> {
  return new Map([...countsByDay].map(([day, count]) => [day, anscombeValue(count)]));
}

export function smoothPoints(countsByDay: Map<number, number>): ActivityPoint[] {
  return [...countsByDay.keys()]
    .sort((left, right) => left - right)
    .map((day) => {
      const neighbors = [
        { day: day - 1, weight: 0.25 },
        { day, weight: 0.5 },
        { day: day + 1, weight: 0.25 },
      ].filter((neighbor) => countsByDay.has(neighbor.day));
      const availableWeight = neighbors.reduce((total, neighbor) => total + neighbor.weight, 0);
      const weightedCount = neighbors.reduce(
        (total, neighbor) => total + (countsByDay.get(neighbor.day) ?? 0) * neighbor.weight,
        0,
      );
      return { day, score: weightedCount / availableWeight };
    });
}

const NORMALIZATION_EPSILON = anscombeValue(1);

function percentile(sortedValues: number[], fraction: number): number {
  const index = fraction * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = requireAt(sortedValues, lower);
  const upperValue = requireAt(sortedValues, upper);
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

export function normalizeWithSoftSaturation(points: ActivityPoint[]): ActivityPoint[] {
  if (points.length === 0) return [];

  const sortedScores = points.map(({ score }) => score).sort((left, right) => left - right);
  const p90 = percentile(sortedScores, 0.9);
  const scale = Math.max(p90, NORMALIZATION_EPSILON);

  return points.map(({ day, score }) => ({ day, score: Math.tanh(score / scale) }));
}

export function padToAxisDays(points: ActivityPoint[]): (ActivityPoint | null)[] {
  const byDay = new Map(points.map((point) => [point.day, point]));
  return Array.from({ length: AXIS_MAX_DAY }, (_, index) => byDay.get(index + 1) ?? null);
}

export function buildMonthSeries({ days, now }: { days: ContributionDay[]; now: Date }): MonthSeries[] {
  if (!Number.isFinite(now.getTime())) throw new Error("Current date is invalid");

  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  return Array.from({ length: MONTHS_BACK }, (_, index) => {
    const date = monthStart(now, index - (MONTHS_BACK - 1));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const isCurrent = year === currentYear && month === currentMonth;
    const countsByDay = new Map<number, number>();

    for (const contribution of days) {
      if (contribution.year !== year || contribution.month !== month) continue;
      if (isCurrent && contribution.day > now.getUTCDate()) continue;

      const day = contribution.day;
      countsByDay.set(day, (countsByDay.get(day) ?? 0) + contribution.count);
    }

    return {
      label: isCurrent ? "Current" : (MONTH_LABELS[month - 1] ?? String(month)),
      points: padToAxisDays(normalizeWithSoftSaturation(smoothPoints(applyAnscombeTransform(countsByDay)))),
      isCurrent,
    };
  });
}

function scaleX(day: number): number {
  return MARGIN.left + ((day - 1) / (AXIS_MAX_DAY - 1)) * PLOT_WIDTH;
}

function scaleY(score: number): number {
  return MARGIN.top + PLOT_HEIGHT - Math.min(1, Math.max(0, score)) * PLOT_HEIGHT;
}

function requireAt<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`Index ${index} out of bounds`);
  return value;
}

function steffenTangents(points: ActivityPoint[]): number[] {
  const n = points.length;
  const h: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const current = requireAt(points, i);
    const next = requireAt(points, i + 1);
    const dx = next.day - current.day;
    h.push(dx);
    s.push((next.score - current.score) / dx);
  }

  const tangents: number[] = new Array(n);
  tangents[0] = requireAt(s, 0);
  tangents[n - 1] = requireAt(s, n - 2);
  for (let i = 1; i < n - 1; i += 1) {
    const sPrev = requireAt(s, i - 1);
    const sNext = requireAt(s, i);
    const hPrev = requireAt(h, i - 1);
    const hNext = requireAt(h, i);
    if (sPrev * sNext <= 0) {
      tangents[i] = 0;
      continue;
    }
    const p = (sPrev * hNext + sNext * hPrev) / (hNext + hPrev);
    const bound = Math.min(Math.abs(p), 2 * Math.abs(sPrev), 2 * Math.abs(sNext));
    tangents[i] = Math.sign(p) * bound;
  }
  return tangents;
}

function buildRunPath(points: ActivityPoint[]): string {
  const first = points[0];
  if (!first) return "";
  if (points.length === 1) return `M ${scaleX(first.day).toFixed(1)} ${scaleY(first.score).toFixed(1)}`;

  const tangents = steffenTangents(points);
  let path = `M ${scaleX(first.day).toFixed(1)} ${scaleY(first.score).toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const current = requireAt(points, i);
    const next = requireAt(points, i + 1);
    const h = next.day - current.day;
    const m0 = requireAt(tangents, i);
    const m1 = requireAt(tangents, i + 1);

    const control1Day = current.day + h / 3;
    const control1Score = current.score + (m0 * h) / 3;
    const control2Day = next.day - h / 3;
    const control2Score = next.score - (m1 * h) / 3;

    path +=
      ` C ${scaleX(control1Day).toFixed(1)} ${scaleY(control1Score).toFixed(1)}` +
      ` ${scaleX(control2Day).toFixed(1)} ${scaleY(control2Score).toFixed(1)}` +
      ` ${scaleX(next.day).toFixed(1)} ${scaleY(next.score).toFixed(1)}`;
  }
  return path;
}

export function buildMonotonePath(points: readonly (ActivityPoint | null)[]): string {
  const runs: ActivityPoint[][] = [];
  let currentRun: ActivityPoint[] = [];
  for (const point of points) {
    if (point === null) {
      if (currentRun.length > 0) runs.push(currentRun);
      currentRun = [];
    } else {
      currentRun.push(point);
    }
  }
  if (currentRun.length > 0) runs.push(currentRun);

  return runs
    .map(buildRunPath)
    .filter((path) => path.length > 0)
    .join(" ");
}

function seriesColor(theme: Theme, index: number): string {
  return theme.seriesColors[index] ?? theme.seriesColors[5];
}

export function renderChart({ theme: themeName, months }: { theme: ThemeName; months: MonthSeries[] }): string {
  const theme = THEMES[themeName];
  const horizontalGuides = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (score) =>
        `<line x1="${MARGIN.left}" y1="${scaleY(score).toFixed(1)}" x2="${MARGIN.left + PLOT_WIDTH}" y2="${scaleY(score).toFixed(1)}" stroke="${theme.gridline}" stroke-width="1" opacity="0.35" />`,
    )
    .join("\n    ");
  const verticalGuides = DAY_GUIDES.map(
    (day) =>
      `<line x1="${scaleX(day).toFixed(1)}" y1="${MARGIN.top}" x2="${scaleX(day).toFixed(1)}" y2="${MARGIN.top + PLOT_HEIGHT}" stroke="${theme.gridline}" stroke-width="1" opacity="0.55" />`,
  ).join("\n    ");
  const dayLabels = DAY_GUIDES.map(
    (day) =>
      `<text x="${scaleX(day).toFixed(1)}" y="${MARGIN.top + PLOT_HEIGHT + 20}" font-size="11" fill="${theme.axisText}" text-anchor="middle" font-family="sans-serif">${day}</text>`,
  ).join("\n    ");
  const paths = months
    .map((month, index) => {
      const color = seriesColor(theme, index);
      return `<path d="${buildMonotonePath(month.points)}" fill="none" stroke="${color}" stroke-width="${month.isCurrent ? 2.8 : 1.6}" stroke-linecap="round" stroke-linejoin="round" opacity="${month.isCurrent ? 1 : 0.72}" />`;
    })
    .join("\n    ");
  const legendStep = PLOT_WIDTH / months.length;
  const legend = months
    .map((month, index) => {
      const color = seriesColor(theme, index);
      const x = MARGIN.left + index * legendStep;
      return `<rect x="${x.toFixed(1)}" y="${MARGIN.top - 25}" width="10" height="10" rx="2" fill="${color}" />
    <text x="${(x + 14).toFixed(1)}" y="${MARGIN.top - 16}" font-size="11" fill="${theme.axisText}" font-family="sans-serif">${month.label}</text>`;
    })
    .join("\n    ");

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="chart-title chart-description" xmlns="http://www.w3.org/2000/svg">
  <title id="chart-title">Contribution rhythm for the last six months</title>
  <desc id="chart-description">Each line shows one month of contribution activity, smoothed over three days and scaled to that month's busiest period.</desc>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="8" fill="${theme.background}" />
  <text x="${MARGIN.left}" y="21" font-size="13" font-weight="600" fill="${theme.title}" font-family="sans-serif">Contribution rhythm</text>
  <g>
    ${legend}
  </g>
  <g>
    ${horizontalGuides}
    ${verticalGuides}
    ${dayLabels}
  </g>
  <g>
    ${paths}
  </g>
  <text x="14" y="${MARGIN.top + PLOT_HEIGHT / 2}" font-size="10" fill="${theme.axisText}" text-anchor="middle" font-family="sans-serif" transform="rotate(-90 14 ${MARGIN.top + PLOT_HEIGHT / 2})">relative monthly activity</text>
  <text x="${WIDTH / 2}" y="${HEIGHT - 8}" font-size="10" fill="${theme.axisText}" text-anchor="middle" font-family="sans-serif">day of month</text>
</svg>`;
}

function dateKey({ year, month, day }: Omit<ContributionDay, "count">): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function assertCompleteCoverage(days: ContributionDay[], now: Date): void {
  const dates = new Set(days.map(dateKey));
  const firstDate = monthStart(now, -(MONTHS_BACK - 1));

  for (let date = firstDate; date <= now; date = new Date(date.getTime() + MILLISECONDS_PER_DAY)) {
    const expected = dateKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
    if (!dates.has(expected)) throw new Error(`Incomplete contribution feed: missing ${expected}`);
  }
}

async function fetchPublicContributionHtml({ login }: { login: string }): Promise<unknown> {
  const response = await fetch(`https://github.com/users/${encodeURIComponent(login)}/contributions`, {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Guilhermeasper-profile-activity-graph",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub contribution feed responded ${response.status}`);
  return response.text();
}

export async function runGenerator({
  login,
  outputDir,
  now = new Date(),
  fetchContributionHtml = fetchPublicContributionHtml,
}: GeneratorOptions): Promise<void> {
  const html = await fetchContributionHtml({ login });
  const days = parseContributionFeed(html);
  assertCompleteCoverage(days, now);
  const months = buildMonthSeries({ days, now });
  const light = renderChart({ theme: "light", months });
  const dark = renderChart({ theme: "dark", months });

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "activity-light.svg"), light, "utf8");
  writeFileSync(join(outputDir, "activity-dark.svg"), dark, "utf8");
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(resolve(scriptPath)).href) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  runGenerator({
    login: process.env.GITHUB_LOGIN ?? "Guilhermeasper",
    outputDir: join(scriptDirectory, "..", "assets"),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
