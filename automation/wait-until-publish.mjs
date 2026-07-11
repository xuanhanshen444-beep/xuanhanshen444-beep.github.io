const now = new Date();
const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(now);
const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
const target = new Date(`${values.year}-${values.month}-${values.day}T11:00:00.000Z`);
const waitMilliseconds = target.getTime() - now.getTime();

if (waitMilliseconds > 0 && waitMilliseconds < 60 * 60 * 1000) {
  console.log(`Report is ready. Waiting ${Math.ceil(waitMilliseconds / 60000)} minutes for the 19:00 Asia/Shanghai publish time.`);
  await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
} else {
  console.log("The scheduled publish time has arrived; continuing immediately.");
}
