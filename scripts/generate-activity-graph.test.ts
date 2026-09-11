import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyAnscombeTransform,
  buildMonotonePath,
  buildMonthSeries,
  normalizeWithSoftSaturation,
  padToAxisDays,
  parseContributionFeed,
  renderChart,
  runGenerator,
  smoothPoints,
} from "./generate-activity-graph.ts";

const MILLISECONDS_PER_DAY = 86_400_000;

function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

function contributionFeed({
  start,
  end,
  countForDate = () => 0,
}: {
  start: string;
  end: string;
  countForDate?: (date: Date) => number;
}): string {
  const fragments: string[] = [];
  const endTime = new Date(`${end}T00:00:00.000Z`).getTime();

  for (
    let date = new Date(`${start}T00:00:00.000Z`);
    date.getTime() <= endTime;
    date = new Date(date.getTime() + MILLISECONDS_PER_DAY)
  ) {
    const dateValue = date.toISOString().slice(0, 10);
    const cellId = `day-${dateValue}`;
    const count = countForDate(date);
    const countText = count === 0 ? "No contributions" : `${count} contribution${count === 1 ? "" : "s"}`;
    fragments.push(`<td data-date="${dateValue}" id="${cellId}"></td>`);
    fragments.push(`<tool-tip for="${cellId}">${countText} on ${dateValue}.</tool-tip>`);
  }

  return fragments.join("\n");
}

async function assertGeneratorPreservesAssets({
  fetchContributionHtml,
  expectedError,
}: {
  fetchContributionHtml: () => Promise<unknown>;
  expectedError: RegExp;
}): Promise<void> {
  const outputDir = await mkdtemp(join(tmpdir(), "activity-graph-test-"));
  const lightPath = join(outputDir, "activity-light.svg");
  const darkPath = join(outputDir, "activity-dark.svg");
  await writeFile(lightPath, "existing light", "utf8");
  await writeFile(darkPath, "existing dark", "utf8");

  await assert.rejects(
    runGenerator({
      login: "Guilhermeasper",
      outputDir,
      now: new Date("2026-09-10T02:00:00.000Z"),
      fetchContributionHtml,
    }),
    expectedError,
  );
  assert.equal(await readFile(lightPath, "utf8"), "existing light");
  assert.equal(await readFile(darkPath, "utf8"), "existing dark");
}

test("parseContributionFeed reads zero, singular, plural, and comma-formatted counts", () => {
  const html = `
    <td data-date="2026-01-01" id="day-1"></td>
    <tool-tip for="day-1">No contributions on January 1st.</tool-tip>
    <td data-date="2026-01-02" id="day-2"></td>
    <tool-tip for="day-2">1 contribution on January 2nd.</tool-tip>
    <td data-date="2026-01-03" id="day-3"></td>
    <tool-tip for="day-3">42 contributions on January 3rd.</tool-tip>
    <td data-date="2026-01-04" id="day-4"></td>
    <tool-tip for="day-4">1,234 contributions on January 4th.</tool-tip>
  `;

  assert.deepEqual(parseContributionFeed(html), [
    { year: 2026, month: 1, day: 1, count: 0 },
    { year: 2026, month: 1, day: 2, count: 1 },
    { year: 2026, month: 1, day: 3, count: 42 },
    { year: 2026, month: 1, day: 4, count: 1234 },
  ]);
});

test("parseContributionFeed rejects duplicate dates", () => {
  const html = `
    <td data-date="2026-01-01" id="day-1"></td>
    <tool-tip for="day-1">1 contribution on January 1st.</tool-tip>
    <td data-date="2026-01-01" id="day-2"></td>
    <tool-tip for="day-2">2 contributions on January 1st.</tool-tip>
  `;

  assert.throws(() => parseContributionFeed(html), /Duplicate contribution date: 2026-01-01/);
});

test("parseContributionFeed rejects invalid dates, malformed counts, missing tooltips, and unmatched tooltips", () => {
  assert.throws(
    () => parseContributionFeed('<td data-date="2026-02-30" id="day-1"></td><tool-tip for="day-1">1 contribution</tool-tip>'),
    /Invalid contribution date/,
  );
  assert.throws(
    () => parseContributionFeed('<td data-date="2026-02-01" id="day-1"></td><tool-tip for="day-1">many contributions</tool-tip>'),
    /Malformed contribution count/,
  );
  assert.throws(
    () => parseContributionFeed('<td data-date="2026-02-01" id="day-1"></td><tool-tip for="day-1">1,2 contributions</tool-tip>'),
    /Malformed contribution count/,
  );
  assert.throws(() => parseContributionFeed('<td data-date="2026-02-01" id="day-1"></td>'), /Missing contribution count/);
  assert.throws(() => parseContributionFeed('<tool-tip for="day-1">1 contribution</tool-tip>'), /Unmatched contribution tooltip/);
});

test("parseContributionFeed keeps the first day of a month stable in the America/Bahia timezone", () => {
  assert.deepEqual(
    parseContributionFeed('<td data-date="2026-09-01" id="day-1"></td><tool-tip for="day-1">1 contribution</tool-tip>'),
    [{ year: 2026, month: 9, day: 1, count: 1 }],
  );
});

test("buildMonthSeries selects six UTC calendar months across a year boundary", () => {
  const days = [
    { year: 2025, month: 7, day: 1, count: 9 },
    { year: 2025, month: 8, day: 1, count: 1 },
    { year: 2025, month: 9, day: 1, count: 1 },
    { year: 2025, month: 10, day: 1, count: 1 },
    { year: 2025, month: 11, day: 1, count: 1 },
    { year: 2025, month: 12, day: 1, count: 1 },
    { year: 2026, month: 1, day: 1, count: 1 },
  ];

  const months = buildMonthSeries({ days, now: new Date("2026-01-15T02:00:00.000Z") });

  assert.deepEqual(
    months.map(({ label, isCurrent }) => ({ label, isCurrent })),
    [
      { label: "Aug", isCurrent: false },
      { label: "Sep", isCurrent: false },
      { label: "Oct", isCurrent: false },
      { label: "Nov", isCurrent: false },
      { label: "Dec", isCurrent: false },
      { label: "Current", isCurrent: true },
    ],
  );
});

test("buildMonthSeries keeps day 29, 30, and 31 as distinct points", () => {
  const days = [
    { year: 2026, month: 5, day: 29, count: 0 },
    { year: 2026, month: 5, day: 30, count: 1 },
    { year: 2026, month: 5, day: 31, count: 4 },
  ];

  const months = buildMonthSeries({ days, now: new Date("2026-06-15T02:00:00.000Z") });
  const may = months.find(({ label }) => label === "May");

  assert.equal(may?.points.length, 31);
  assert.ok(may?.points.slice(0, 28).every((point) => point === null));
  const [day29, day30, day31] = may?.points.filter(nonNull) ?? [];
  assert.deepEqual(
    [day29, day30, day31].map((point) => point?.day),
    [29, 30, 31],
  );
  assert.ok((day29?.score ?? 0) < (day30?.score ?? 0));
  assert.ok((day30?.score ?? 0) < (day31?.score ?? 0));
});

test("buildMonthSeries pads a 30-day month with a null day-31 slot", () => {
  const days = Array.from({ length: 30 }, (_, index) => ({
    year: 2026,
    month: 4,
    day: index + 1,
    count: 1,
  }));

  const months = buildMonthSeries({ days, now: new Date("2026-05-10T02:00:00.000Z") });
  const april = months.find(({ label }) => label === "Apr");

  assert.equal(april?.points.length, 31);
  assert.equal(april?.points[29]?.day, 30);
  assert.equal(april?.points[30], null);
});

test("buildMonthSeries stops the current month at the current UTC day", () => {
  const days = [
    { year: 2026, month: 9, day: 9, count: 1 },
    { year: 2026, month: 9, day: 10, count: 1 },
    { year: 2026, month: 9, day: 11, count: 99 },
  ];

  const months = buildMonthSeries({ days, now: new Date("2026-09-10T02:00:00.000Z") });

  assert.equal(months.at(-1)?.points.length, 31);
  assert.deepEqual(
    months.at(-1)?.points.filter(nonNull).map(({ day }) => day),
    [9, 10],
  );
  assert.equal(months.at(-1)?.points[10], null);
});

test("buildMonthSeries handles February, leap years, and an inactive month", () => {
  const leapDays = Array.from({ length: 29 }, (_, index) => ({ year: 2024, month: 2, day: index + 1, count: 0 }));
  const regularDays = Array.from({ length: 28 }, (_, index) => ({ year: 2026, month: 2, day: index + 1, count: 1 }));
  const leapFebruary = buildMonthSeries({ days: leapDays, now: new Date("2024-03-10T02:00:00.000Z") }).find(
    ({ label }) => label === "Feb",
  );
  const regularFebruary = buildMonthSeries({ days: regularDays, now: new Date("2026-03-10T02:00:00.000Z") }).find(
    ({ label }) => label === "Feb",
  );

  assert.equal(leapFebruary?.points.length, 31);
  const leapReal = leapFebruary?.points.filter(nonNull) ?? [];
  assert.equal(leapReal.length, 29);
  assert.equal(leapReal.at(-1)?.day, 29);
  assert.ok(leapReal.every(({ score }) => score === 0));
  assert.ok(leapFebruary?.points.slice(29).every((point) => point === null));

  assert.equal(regularFebruary?.points.length, 31);
  const regularReal = regularFebruary?.points.filter(nonNull) ?? [];
  assert.equal(regularReal.length, 28);
  assert.equal(regularReal.at(-1)?.day, 28);
  assert.ok(regularFebruary?.points.slice(28).every((point) => point === null));
});

test("buildMonthSeries spreads an isolated spike onto its smoothed neighbors", () => {
  const days = [
    { year: 2026, month: 8, day: 1, count: 0 },
    { year: 2026, month: 8, day: 2, count: 4 },
    { year: 2026, month: 8, day: 3, count: 0 },
  ];
  const august = buildMonthSeries({ days, now: new Date("2026-09-10T02:00:00.000Z") }).find(
    ({ label }) => label === "Aug",
  );

  assert.equal(august?.points.length, 31);
  const [day1, day2, day3] = august?.points.filter(nonNull) ?? [];
  assert.deepEqual([day1, day2, day3].map((point) => point?.day), [1, 2, 3]);
  assert.equal(day1?.score, day3?.score);
  assert.ok((day1?.score ?? 0) > 0, "boundary days should receive smoothed spillover from the spike");
  assert.ok((day2?.score ?? 0) > (day1?.score ?? 0), "the spike day should score higher than its neighbors");
  assert.ok(august?.points.slice(3).every((point) => point === null));
});

test("applyAnscombeTransform maps zero to zero and compresses larger counts", () => {
  const result = applyAnscombeTransform(
    new Map([
      [1, 0],
      [2, 1],
      [3, 4],
      [4, 9],
    ]),
  );

  const values = [...result.values()];
  assert.equal(values[0], 0);
  assertClose(values[1] ?? NaN, 1.120463008520126);
  assertClose(values[2] ?? NaN, 2.958555261278789);
  assertClose(values[3] ?? NaN, 4.898979485566356);
});

test("applyAnscombeTransform is monotonically increasing and handles an empty map", () => {
  const result = applyAnscombeTransform(
    new Map([
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
  );
  const values = [...result.values()];
  assert.ok((values[0] ?? 0) < (values[1] ?? 0));
  assert.ok((values[1] ?? 0) < (values[2] ?? 0));
  assert.deepEqual([...applyAnscombeTransform(new Map())], []);
});

test("smoothPoints applies centered weights and renormalizes boundary weights without normalizing to [0,1]", () => {
  const points = smoothPoints(
    new Map([
      [1, 0],
      [2, 4],
      [3, 0],
    ]),
  );

  assert.deepEqual(points, [
    { day: 1, score: 4 / 3 },
    { day: 2, score: 2 },
    { day: 3, score: 4 / 3 },
  ]);
});

test("smoothPoints returns all-zero scores for an all-zero month", () => {
  const points = smoothPoints(
    new Map([
      [1, 0],
      [2, 0],
    ]),
  );

  assert.deepEqual(points, [
    { day: 1, score: 0 },
    { day: 2, score: 0 },
  ]);
});

test("normalizeWithSoftSaturation scales by the 90th percentile and soft-clips with tanh", () => {
  const points = [0, 1, 2, 3, 4].map((score, index) => ({ day: index + 1, score }));

  const result = normalizeWithSoftSaturation(points);

  assertClose(result[0]?.score ?? NaN, 0);
  assertClose(result[1]?.score ?? NaN, 0.2708471185167214);
  assertClose(result[2]?.score ?? NaN, 0.5046723977218567);
  assertClose(result[3]?.score ?? NaN, 0.6822617902381696);
  assertClose(result[4]?.score ?? NaN, 0.8044548002984013);
});

test("normalizeWithSoftSaturation floors the scale at epsilon so faint months don't get amplified to full scale", () => {
  const faintScore = (2 / 3) * 1.120463008520126;
  const result = normalizeWithSoftSaturation([{ day: 1, score: faintScore }]);

  assertClose(result[0]?.score ?? NaN, 0.5827829453479102);
});

test("normalizeWithSoftSaturation maps an all-zero month to all-zero scores", () => {
  const result = normalizeWithSoftSaturation([
    { day: 1, score: 0 },
    { day: 2, score: 0 },
  ]);

  assert.deepEqual(result, [
    { day: 1, score: 0 },
    { day: 2, score: 0 },
  ]);
});

test("normalizeWithSoftSaturation handles an empty series", () => {
  assert.deepEqual(normalizeWithSoftSaturation([]), []);
});

test("padToAxisDays fills a fixed 31-slot axis with null for missing days", () => {
  const padded = padToAxisDays([
    { day: 1, score: 0.1 },
    { day: 2, score: 0.2 },
  ]);

  assert.equal(padded.length, 31);
  assert.deepEqual(padded[0], { day: 1, score: 0.1 });
  assert.deepEqual(padded[1], { day: 2, score: 0.2 });
  assert.ok(padded.slice(2).every((point) => point === null));
});

test("padToAxisDays places points by day number, not by array position", () => {
  const padded = padToAxisDays([
    { day: 29, score: 0.5 },
    { day: 31, score: 1 },
  ]);

  assert.equal(padded.length, 31);
  assert.ok(padded.slice(0, 28).every((point) => point === null));
  assert.deepEqual(padded[28], { day: 29, score: 0.5 });
  assert.equal(padded[29], null);
  assert.deepEqual(padded[30], { day: 31, score: 1 });
});

function extractPathYCoordinates(path: string): number[] {
  const segments = path.split(" C ");
  const startCoordinates = segments[0]?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const yCoordinates = startCoordinates[1] === undefined ? [] : [startCoordinates[1]];
  for (const segment of segments.slice(1)) {
    const coordinates = segment.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    for (const index of [1, 3, 5]) {
      const y = coordinates[index];
      if (y !== undefined) yCoordinates.push(y);
    }
  }
  return yCoordinates;
}

test("buildMonotonePath does not overshoot an isolated spike", () => {
  const points = [
    { day: 1, score: 0 },
    { day: 2, score: 0 },
    { day: 3, score: 1 },
    { day: 4, score: 0 },
    { day: 5, score: 0 },
  ];

  const path = buildMonotonePath(points);
  const yCoordinates = extractPathYCoordinates(path);
  assert.ok(yCoordinates.every((y) => y >= 72 && y <= 258));
});

test("buildMonotonePath does not overshoot a plateau", () => {
  const points = [
    { day: 1, score: 0 },
    { day: 2, score: 1 },
    { day: 3, score: 1 },
    { day: 4, score: 0 },
  ];

  const path = buildMonotonePath(points);
  const yCoordinates = extractPathYCoordinates(path);
  assert.ok(yCoordinates.every((y) => y >= 72 && y <= 258));
});

test("buildMonotonePath handles zero, one, and two points", () => {
  assert.equal(buildMonotonePath([]), "");

  const single = buildMonotonePath([{ day: 1, score: 0.5 }]);
  assert.doesNotMatch(single, / C /);
  assert.match(single, /^M /);

  const pair = buildMonotonePath([
    { day: 1, score: 0 },
    { day: 2, score: 1 },
  ]);
  assert.equal(pair.split(" C ").length - 1, 1);
});

test("buildMonotonePath breaks the line into separate subpaths at null gaps", () => {
  const path = buildMonotonePath([
    { day: 1, score: 0 },
    { day: 2, score: 1 },
    null,
    null,
    { day: 5, score: 0 },
    { day: 6, score: 1 },
  ]);

  const moveToCount = path.split(" ").filter((token) => token === "M").length;
  assert.equal(moveToCount, 2, "each run separated by a gap should start with its own M command");
  assert.equal(path.split(" C ").length - 1, 2, "each two-point run draws exactly one C segment");
});

test("buildMonotonePath skips leading and trailing null gaps entirely", () => {
  const path = buildMonotonePath([null, null, { day: 3, score: 0.5 }, null]);
  assert.equal(path.split(" ").filter((token) => token === "M").length, 1);
  assert.doesNotMatch(path, / C /);
});

test("buildMonotonePath returns an empty string when every slot is null", () => {
  assert.equal(buildMonotonePath([null, null, null]), "");
});

test("renderChart creates an accessible smooth six-series chart with aligned day guides", () => {
  const months = ["Apr", "May", "Jun", "Jul", "Aug", "Current"].map((label, index, labels) => ({
    label,
    isCurrent: index === labels.length - 1,
    points: [
      { day: 1, score: 0 },
      { day: 15, score: 1 },
      { day: 30, score: 0.5 },
    ],
  }));

  const svg = renderChart({ theme: "light", months });

  assert.match(svg, /<title id="chart-title">Contribution rhythm for the last six months<\/title>/);
  assert.match(svg, /<desc id="chart-description">/);
  assert.match(svg, />relative monthly activity<\/text>/);
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(paths.length, 6);
  assert.ok(paths.every((path) => path?.includes(" C ")));
  assert.match(svg, /<path[^>]+stroke-width="1.6"[^>]+opacity="0.72"/);
  assert.match(svg, /<path[^>]+stroke-width="2.8"[^>]+opacity="1"/);
  assert.doesNotMatch(svg, /data-count|contributionCount|contributions on/i);
  assert.deepEqual(
    [...svg.matchAll(/<path[^>]+stroke="([^"]+)"/g)].map((match) => match[1]),
    ["#a21caf", "#c2410c", "#a16207", "#15803d", "#0e7490", "#06005b"],
  );
  const darkSvg = renderChart({ theme: "dark", months });
  assert.deepEqual(
    [...darkSvg.matchAll(/<path[^>]+stroke="([^"]+)"/g)].map((match) => match[1]),
    ["#f0abfc", "#fdba74", "#fde047", "#4ade80", "#67e8f9", "#a4aafe"],
  );

  let previousLabelPosition = -1;
  for (const { label } of months) {
    const labelPosition = svg.indexOf(`>${label}</text>`);
    assert.ok(labelPosition > previousLabelPosition);
    previousLabelPosition = labelPosition;
  }

  for (const path of paths) {
    if (!path) continue;
    assert.ok(extractPathYCoordinates(path).every((y) => y >= 72 && y <= 258));
  }

  for (const day of [1, 6, 11, 16, 21, 26, 31]) {
    const labelX = svg.match(new RegExp(`<text x="([^"]+)"[^>]*>${day}<\\/text>`))?.[1];
    assert.ok(labelX);
    assert.match(svg, new RegExp(`<line x1="${labelX}"[^>]*x2="${labelX}"`));
  }
});

test("runGenerator preserves existing assets when the contribution feed is incomplete", async () => {
  await assertGeneratorPreservesAssets({
    fetchContributionHtml: async () => "<html></html>",
    expectedError: /Incomplete contribution feed/,
  });
});

test("runGenerator preserves existing assets when parsing fails", async () => {
  await assertGeneratorPreservesAssets({
    fetchContributionHtml: async () =>
      '<td data-date="2026-04-01" id="day-1"></td><tool-tip for="day-1">many contributions</tool-tip>',
    expectedError: /Malformed contribution count/,
  });
});

test("runGenerator preserves existing assets when fetching fails", async () => {
  await assertGeneratorPreservesAssets({
    fetchContributionHtml: async () => {
      throw new Error("Simulated HTTP failure");
    },
    expectedError: /Simulated HTTP failure/,
  });
});

test("runGenerator writes complete light and dark charts from one feed", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "activity-graph-test-"));
  let fetchCount = 0;
  const html = contributionFeed({
    start: "2026-04-01",
    end: "2026-09-10",
    countForDate: (date) => date.getUTCDate() % 5,
  });

  await runGenerator({
    login: "Guilhermeasper",
    outputDir,
    now: new Date("2026-09-10T02:00:00.000Z"),
    fetchContributionHtml: async () => {
      fetchCount += 1;
      return html;
    },
  });

  const light = await readFile(join(outputDir, "activity-light.svg"), "utf8");
  const dark = await readFile(join(outputDir, "activity-dark.svg"), "utf8");
  assert.equal(fetchCount, 1);
  assert.match(light, /fill="#ffffff"/);
  assert.match(light, /fill="#06005b"/);
  assert.match(dark, /fill="#0d1117"/);
  assert.match(dark, /fill="#a4aafe"/);
  assert.equal([...light.matchAll(/<path /g)].length, 6);
  assert.equal([...dark.matchAll(/<path /g)].length, 6);
});
