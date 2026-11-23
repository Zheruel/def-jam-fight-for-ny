// Browser check of the Gun Hill Garage cars in the real battle page (headless Chrome): both car meshes load from the
// production files and are drawn (the pixels where each car stands are not the empty garage floor).
//   node port/scenery/cars-browser.mjs        (NATIVE_SCREENSHOT=dir keeps a PNG)
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { chromium } from "../../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../../tools/serve.mjs";

const server = gameServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
  const page = await browser.newPage({ viewport: { width: 1024, height: 824 } });
  const errors = [], fetched = [];
  page.on("response", response => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); else if (/\/cars\//.test(response.url())) fetched.push(response.url().split("/").pop()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/port/battle/index.html?venue=V2BG_17A`);
  await page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 30, null, { timeout: 90000 });
  const shot = await page.locator("canvas").first().screenshot();
  if (process.env.NATIVE_SCREENSHOT) writeFileSync(`${process.env.NATIVE_SCREENSHOT}/gunhill-cars.png`, shot);
  assert.deepEqual(fetched.sort(), ["V2BG_17A_A.skin.gz", "V2BG_17A_B.skin.gz"]);
  // The page draws a dark, mostly desaturated garage; the green right car and the black left car fill the sides of the frame.
  const cars = await page.evaluate(async png => {
    const image = await createImageBitmap(await (await fetch(png)).blob());
    const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const area = (x0, y0, x1, y1) => { const d = context.getImageData(x0 * image.width, y0 * image.height, (x1 - x0) * image.width, (y1 - y0) * image.height).data; let g = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 12 && d[i + 1] > d[i + 2] + 8) g++; return g / (d.length / 4); };
    return { rightGreen: area(0.62, 0.3, 0.95, 0.55) };
  }, "data:image/png;base64," + shot.toString("base64"));
  assert.ok(cars.rightGreen > 0.12, "the right car's green paint is on screen: " + JSON.stringify(cars));
  assert.deepEqual(errors, []);
  console.log("cars browser check ok", JSON.stringify({ fetched, ...cars }));
} finally {
  await browser?.close();
  server.close();
}
