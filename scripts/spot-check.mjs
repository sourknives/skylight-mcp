// Live spot-check of Skylight MCP tool layers. Read-only.
import { initializeClient } from "../dist/api/client.js";
import * as calendar from "../dist/api/endpoints/calendar.js";
import * as chores from "../dist/api/endpoints/chores.js";
import * as categories from "../dist/api/endpoints/categories.js";
import * as lists from "../dist/api/endpoints/lists.js";
import * as frames from "../dist/api/endpoints/frames.js";
import * as devices from "../dist/api/endpoints/devices.js";
import * as misc from "../dist/api/endpoints/misc.js";
import * as rewards from "../dist/api/endpoints/rewards.js";
import * as meals from "../dist/api/endpoints/meals.js";
import * as photos from "../dist/api/endpoints/photos.js";
import * as taskbox from "../dist/api/endpoints/taskbox.js";

const results = [];
async function run(name, fn) {
  try {
    const r = await fn();
    const count = Array.isArray(r?.data) ? r.data.length
      : Array.isArray(r) ? r.length
      : r && typeof r === "object" ? Object.keys(r).length
      : 0;
    results.push({ name, ok: true, count });
    console.log(`OK   ${name} (${count})`);
  } catch (e) {
    results.push({ name, ok: false, error: e?.message ?? String(e) });
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}

const client = await initializeClient();
console.log(`plus=${client.hasPlus()} status=${client.getSubscriptionStatus()} frame=${client.frameId}\n`);

// Base tools
await run("frames.getFrame", () => frames.getFrame());
await run("frames.getFamilyMembers", () => frames.getFamilyMembers());
await run("devices.getDevices", () => devices.getDevices());
await run("misc.getAvatars", () => misc.getAvatars());
await run("misc.getColors", () => misc.getColors());
await run("calendar.getSourceCalendars", () => calendar.getSourceCalendars());
await run("calendar.getCalendarEvents(today..+7d)", () => {
  const today = new Date();
  const end = new Date(today); end.setDate(end.getDate() + 7);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return calendar.getCalendarEvents({ date_min: fmt(today), date_max: fmt(end) });
});
await run("categories.getCategories", () => categories.getCategories());
await run("categories.getChoreChartCategories", () => categories.getChoreChartCategories());
await run("chores.getChores", () => chores.getChores());
await run("lists.getLists", () => lists.getLists());
await run("taskbox.getTaskBoxItems", () => taskbox.getTaskBoxItems());

// Plus-only
if (client.hasPlus()) {
  await run("rewards.getRewards", () => rewards.getRewards());
  await run("rewards.getRewardPoints", () => rewards.getRewardPoints());
  await run("meals.getMealCategories", () => meals.getMealCategories());
  await run("meals.getRecipes", () => meals.getRecipes());
  await run("meals.getMealSittings", () => meals.getMealSittings());
  await run("photos.getAlbums", () => photos.getAlbums());
} else {
  console.log("\nskipping plus-only (no plus subscription)");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`);
for (const f of failed) console.log(`- ${f.name}: ${f.error}`);
process.exit(failed.length ? 1 : 0);
