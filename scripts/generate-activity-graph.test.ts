import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMonthSeries, parseContributionFeed, renderChart, runGenerator } from "./generate-activity-graph.ts";

const MILLISECONDS_PER_DAY = 86_400_000;

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

test("buildMonthSeries folds day 31 before smoothing and monthly normalization", () => {
  const days = [
    { year: 2026, month: 5, day: 29, count: 0 },
    { year: 2026, month: 5, day: 30, count: 2 },
    { year: 2026, month: 5, day: 31, count: 6 },
  ];

  const months = buildMonthSeries({ days, now: new Date("2026-06-15T02:00:00.000Z") });
  const may = months.find(({ label }) => label === "May");

  assert.deepEqual(may?.points, [
    { day: 29, score: 0.5 },
    { day: 30, score: 1 },
  ]);
});

test("buildMonthSeries stops the current month at the current UTC day", () => {
  const days = [
    { year: 2026, month: 9, day: 9, count: 1 },
    { year: 2026, month: 9, day: 10, count: 1 },
    { year: 2026, month: 9, day: 11, count: 99 },
  ];

  const months = buildMonthSeries({ days, now: new Date("2026-09-10T02:00:00.000Z") });

  assert.deepEqual(
    months.at(-1)?.points.map(({ day }) => day),
    [9, 10],
  );
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

  assert.equal(leapFebruary?.points.length, 29);
  assert.ok(leapFebruary?.points.every(({ score }) => score === 0));
  assert.equal(regularFebruary?.points.length, 28);
});

test("buildMonthSeries applies centered weights and renormalizes boundary weights", () => {
  const days = [
    { year: 2026, month: 8, day: 1, count: 0 },
    { year: 2026, month: 8, day: 2, count: 4 },
    { year: 2026, month: 8, day: 3, count: 0 },
  ];
  const august = buildMonthSeries({ days, now: new Date("2026-09-10T02:00:00.000Z") }).find(
    ({ label }) => label === "Aug",
  );

  assert.deepEqual(august?.points, [
    { day: 1, score: 2 / 3 },
    { day: 2, score: 1 },
    { day: 3, score: 2 / 3 },
  ]);
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
    const segments = path?.split(" C ") ?? [];
    const startCoordinates = segments[0]?.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const yCoordinates = startCoordinates[1] === undefined ? [] : [startCoordinates[1]];
    for (const segment of segments.slice(1)) {
      const coordinates = segment.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      for (const index of [1, 3, 5]) {
        const y = coordinates[index];
        if (y !== undefined) yCoordinates.push(y);
      }
    }
    assert.ok(yCoordinates.every((y) => y >= 72 && y <= 258));
  }

  for (const day of [1, 5, 10, 15, 20, 25, 30]) {
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
