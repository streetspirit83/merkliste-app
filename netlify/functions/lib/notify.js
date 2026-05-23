/**
 * notify.js — ntfy.sh push sender
 */

const PRIORITY = { red: "4", orange: "3", green: "3" };
const TAGS     = { red: "rotating_light", orange: "warning", green: "white_check_mark" };

export async function sendNtfy(topic, { title, message, pushColor = null }) {
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      "Title":    encodeURIComponent(title),
      "Priority": PRIORITY[pushColor] ?? "3",
      "Tags":     TAGS[pushColor]     ?? "bell",
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: message,
  });
  if (!res.ok) console.warn(`[ntfy] HTTP ${res.status} für "${title}"`);
  return res.ok;
}
