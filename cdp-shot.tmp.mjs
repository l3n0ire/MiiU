// CDP screenshot driver: navigate, wait real ms, optional speed override, screenshot.
import { spawn } from "node:child_process";
import fs from "node:fs";
import WebSocket from "ws";

const [url, waitMs, out, speed] = process.argv.slice(2);
const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--remote-debugging-port=9223", `--window-size=${process.env.WIN || "1280,900"}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await fetch("http://localhost:9223/json/new?about:blank", { method: "PUT" });
      target = await res.json();
      break;
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let mid = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++mid;
    const onMsg = (data) => {
      const m = JSON.parse(data);
      if (m.id === id) { ws.off("message", onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await sleep(1500);
  if (speed) {
    await send("Runtime.evaluate", { expression:
      `const s=document.getElementById('speedRange'); if(s){s.value='${speed}'; s.dispatchEvent(new Event('input'));}` });
  }
  await sleep(Number(waitMs));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  // also grab status + now line text for the log
  const txt = await send("Runtime.evaluate", { expression:
    `JSON.stringify({status: document.getElementById('puzzleStatus')?.textContent, now: document.getElementById('nowLine')?.textContent, driver: document.getElementById('crewDriver')?.textContent, last: document.getElementById('crewLast')?.textContent, win: document.getElementById('winStats')?.textContent})` });
  console.log(txt.result.value);
  ws.close();
} finally {
  chrome.kill("SIGKILL");
}
